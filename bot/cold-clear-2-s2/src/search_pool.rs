//! Process-wide helper threads for batched expansion (`search_threads`).
//!
//! `run(threads, count, job)` calls `job(i)` once for every `i < count`, on the
//! calling thread and up to `threads - 1` helpers, and returns only after every
//! call has finished, so `job` may borrow from the caller's stack. Helpers spin
//! briefly between batches (a decision runs batches back to back) and park
//! after a short idle period. Which thread runs which index never affects the
//! result: callers write each index's output to its own slot.
//!
//! Native, and wasm32-wasip1-threads with the `wasm-threads` feature (WASI threads on shared
//! memory); the import-free wasm32-unknown-unknown build has no threads and callers run the jobs
//! in order.
//!
//! Placement (Windows): when the pool is created, the calling thread claims up
//! to `threads` free physical P-cores (inside the process affinity mask, never
//! two pool threads on one core and never an E-core while the CPU has faster
//! cores) through one named mutex per core, so several bot processes on one PC
//! take disjoint cores. The caller and each helper are pinned to the logical
//! CPUs of their own claimed core; fewer free cores mean fewer helpers (the
//! result never depends on the thread count). A mutex is released when its
//! process exits. `CC2_SEARCH_PLACEMENT=off` keeps the unpinned pool with
//! `threads - 1` helpers; `CC2_SEARCH_PLACEMENT_LOG` names a file that gets one
//! line per pool with the claimed masks.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use once_cell::sync::OnceCell;

type Job = dyn Fn(usize) + Sync + 'static;

/// A job pointer with its lifetime erased; valid only during its epoch.
#[derive(Clone, Copy)]
struct JobPtr(*const Job);
unsafe impl Send for JobPtr {}

struct Shared {
    /// (epoch, job, count) of the current batch.
    current: Mutex<(u64, Option<JobPtr>, usize)>,
    wake: Condvar,
    epoch: AtomicU64,
    /// High 32 bits: epoch (low bits of it); low 32 bits: next index to claim.
    claim: AtomicU64,
    done: AtomicUsize,
    parked: AtomicUsize,
    shutdown: AtomicBool,
    /// Set when a job of the current batch panicked; its payload (the first)
    /// is re-raised on the submitting caller once every job has finished.
    failed: AtomicBool,
    panic: Mutex<Option<Box<dyn std::any::Any + Send>>>,
}

impl Shared {
    fn record_panic(&self, payload: Box<dyn std::any::Any + Send>) {
        let mut slot = self.panic.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.is_none() {
            *slot = Some(payload);
        } else {
            // Never dropped here: a payload whose drop panics would escape
            // `run_job` before the job is counted as done.
            std::mem::forget(payload);
        }
        self.failed.store(true, Ordering::Release);
    }

    fn take_panic(&self) -> Option<Box<dyn std::any::Any + Send>> {
        self.panic.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take()
    }
}

pub(crate) struct SearchPool {
    shared: Arc<Shared>,
    helpers: usize,
    /// Held for a whole batch: the pool runs one batch at a time.
    serial: Mutex<()>,
}

static POOL: OnceCell<SearchPool> = OnceCell::new();

/// Spins before a helper parks (each spin is one `spin_loop` hint).
const SPINS_BEFORE_PARK: u32 = 1 << 16;

impl SearchPool {
    fn new(threads: usize) -> Self {
        let masks = placement::claim(threads);
        let helpers = match &masks {
            Some(masks) => masks.len().saturating_sub(1),
            None => threads.saturating_sub(1),
        };
        if let Some(&first) = masks.as_ref().and_then(|m| m.first()) {
            placement::pin_current_thread(first);
        }
        let shared = Arc::new(Shared {
            current: Mutex::new((0, None, 0)),
            wake: Condvar::new(),
            epoch: AtomicU64::new(0),
            claim: AtomicU64::new(0),
            done: AtomicUsize::new(0),
            parked: AtomicUsize::new(0),
            shutdown: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            panic: Mutex::new(None),
        });
        for i in 0..helpers {
            let shared = Arc::clone(&shared);
            let mask = masks.as_ref().map(|m| m[i + 1]);
            std::thread::spawn(move || {
                if let Some(mask) = mask {
                    placement::pin_current_thread(mask);
                }
                helper_loop(&shared)
            });
        }
        SearchPool { shared, helpers, serial: Mutex::new(()) }
    }

    /// The batch lock, or `None` while another search of this process holds
    /// the pool (that caller then runs its jobs in order on its own thread;
    /// the result is the same).
    fn try_serial(&self) -> Option<std::sync::MutexGuard<'_, ()>> {
        match self.serial.try_lock() {
            Ok(guard) => Some(guard),
            Err(std::sync::TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => None,
        }
    }

    /// Runs `job(0..count)` on the caller plus up to `threads - 1` helpers.
    pub(crate) fn run<'a>(threads: usize, count: usize, job: &'a (dyn Fn(usize) + Sync + 'a)) {
        let pool = POOL.get_or_init(|| SearchPool::new(threads));
        let serial = if pool.helpers == 0 || count <= 1 { None } else { pool.try_serial() };
        if serial.is_none() {
            (0..count).for_each(job);
            return;
        }
        let shared = &pool.shared;
        // SAFETY: the pointer is only dereferenced for indices claimed under
        // this epoch, and this function returns only after all of them ran.
        let ptr = JobPtr(unsafe { std::mem::transmute::<&'a (dyn Fn(usize) + Sync + 'a), &'static Job>(job) } as *const Job);
        let epoch = shared.epoch.load(Ordering::Relaxed) + 1;
        {
            let mut current = shared.current.lock().unwrap();
            *current = (epoch, Some(ptr), count);
            shared.done.store(0, Ordering::Relaxed);
            shared.failed.store(false, Ordering::Relaxed);
            shared.claim.store((epoch & 0xffff_ffff) << 32, Ordering::Release);
            shared.epoch.store(epoch, Ordering::Release);
        }
        if shared.parked.load(Ordering::Acquire) > 0 {
            shared.wake.notify_all();
        }
        let ran = claim_and_run(shared, epoch, ptr, count);
        let mut finished = shared.done.fetch_add(ran, Ordering::AcqRel) + ran;
        while finished < count {
            std::hint::spin_loop();
            finished = shared.done.load(Ordering::Acquire);
        }
        shared.current.lock().unwrap().1 = None;
        // Every job has finished (a panicking one included), so no job can
        // still reach the caller's borrows: now the panic may unwind them.
        if let Some(payload) = shared.take_panic() {
            std::panic::resume_unwind(payload);
        }
    }
}

impl SearchPool {
    /// Like `run`, but the caller consumes the results in index order while the
    /// helpers keep computing: once `ready(i)` holds, `consume(i)` runs on the
    /// caller, for i = 0, 1, ... While index i is not ready the caller computes
    /// the next unclaimed index itself (at most one job of delay before it
    /// consumes i). Returns after every job and every consume ran.
    pub(crate) fn run_streamed<'a>(
        threads: usize,
        count: usize,
        job: &'a (dyn Fn(usize) + Sync + 'a),
        ready: &dyn Fn(usize) -> bool,
        mut consume: impl FnMut(usize),
    ) {
        let pool = POOL.get_or_init(|| SearchPool::new(threads));
        let serial = if pool.helpers == 0 || count <= 1 { None } else { pool.try_serial() };
        if serial.is_none() {
            for i in 0..count {
                job(i);
                consume(i);
            }
            return;
        }
        let shared = &pool.shared;
        // SAFETY: as in `run`; this function returns only after all claimed indices ran.
        let ptr = JobPtr(unsafe { std::mem::transmute::<&'a (dyn Fn(usize) + Sync + 'a), &'static Job>(job) } as *const Job);
        let epoch = shared.epoch.load(Ordering::Relaxed) + 1;
        let tag = (epoch & 0xffff_ffff) << 32;
        {
            let mut current = shared.current.lock().unwrap();
            *current = (epoch, Some(ptr), count);
            shared.done.store(0, Ordering::Relaxed);
            shared.failed.store(false, Ordering::Relaxed);
            shared.claim.store(tag, Ordering::Release);
            shared.epoch.store(epoch, Ordering::Release);
        }
        if shared.parked.load(Ordering::Acquire) > 0 {
            shared.wake.notify_all();
        }
        // A panic in `ready` or `consume` is caught too: the helpers may still
        // run jobs that borrow from the caller, so it unwinds only after them.
        let streamed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            for i in 0..count {
                while !ready(i) {
                    if shared.failed.load(Ordering::Acquire) {
                        // A job panicked and will never be ready.
                        return;
                    }
                    // Help with the next unclaimed index (at most one job of delay before consuming i).
                    let claim = shared.claim.load(Ordering::Acquire);
                    let next = (claim & 0xffff_ffff) as usize;
                    if claim & !0xffff_ffff == tag && next < count
                        && shared.claim.compare_exchange_weak(claim, claim + 1, Ordering::AcqRel, Ordering::Relaxed).is_ok()
                    {
                        run_job(shared, ptr, next);
                        shared.done.fetch_add(1, Ordering::AcqRel);
                    } else {
                        std::hint::spin_loop();
                    }
                }
                consume(i);
            }
        }));
        // After a panic, finish the unclaimed jobs too, then wait for all.
        let ran = claim_and_run(shared, epoch, ptr, count);
        if ran > 0 {
            shared.done.fetch_add(ran, Ordering::AcqRel);
        }
        while shared.done.load(Ordering::Acquire) < count {
            std::hint::spin_loop();
        }
        shared.current.lock().unwrap().1 = None;
        let job_panic = shared.take_panic();
        if let Err(payload) = streamed {
            std::mem::forget(job_panic);
            std::panic::resume_unwind(payload);
        }
        if let Some(payload) = job_panic {
            std::panic::resume_unwind(payload);
        }
    }
}

/// Claims indices of `epoch` until none are left; returns how many it ran.
fn claim_and_run(shared: &Shared, epoch: u64, ptr: JobPtr, count: usize) -> usize {
    let tag = (epoch & 0xffff_ffff) << 32;
    let mut ran = 0;
    loop {
        let claim = shared.claim.load(Ordering::Acquire);
        if claim & !0xffff_ffff != tag {
            return ran;
        }
        let index = (claim & 0xffff_ffff) as usize;
        if index >= count {
            return ran;
        }
        if shared.claim.compare_exchange_weak(claim, claim + 1, Ordering::AcqRel, Ordering::Relaxed).is_ok() {
            run_job(shared, ptr, index);
            ran += 1;
        }
    }
}

/// Runs one claimed job. A panic is kept for the submitting caller instead of
/// unwinding here, so the job still counts as finished.
fn run_job(shared: &Shared, ptr: JobPtr, index: usize) {
    // SAFETY: claimed under the current epoch; see `SearchPool::run`.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe { (*ptr.0)(index) }));
    if let Err(payload) = result {
        shared.record_panic(payload);
    }
}

fn helper_loop(shared: &Shared) {
    let mut seen = 0;
    loop {
        let mut spins = 0;
        while shared.epoch.load(Ordering::Acquire) == seen {
            if shared.shutdown.load(Ordering::Relaxed) {
                return;
            }
            if spins < SPINS_BEFORE_PARK {
                std::hint::spin_loop();
                spins += 1;
                continue;
            }
            let guard = shared.current.lock().unwrap();
            shared.parked.fetch_add(1, Ordering::AcqRel);
            let _guard = shared.wake.wait_while(guard, |current| current.0 == seen).unwrap();
            shared.parked.fetch_sub(1, Ordering::AcqRel);
        }
        let (epoch, job, count) = *shared.current.lock().unwrap();
        seen = epoch;
        if let Some(ptr) = job {
            let ran = claim_and_run(shared, epoch, ptr, count);
            if ran > 0 {
                shared.done.fetch_add(ran, Ordering::AcqRel);
            }
        }
    }
}

/// Free physical P-core claiming and thread pinning (see the module docs).
mod placement {
    /// Logical-CPU masks of the claimed cores (the first for the caller), or
    /// `None` when placement is off or unsupported (unpinned pool).
    pub(super) fn claim(threads: usize) -> Option<Vec<usize>> {
        if std::env::var("CC2_SEARCH_PLACEMENT").is_ok_and(|v| v == "off") {
            return None;
        }
        let masks = imp::claim(threads)?;
        if let Some(path) = std::env::var_os("CC2_SEARCH_PLACEMENT_LOG") {
            use std::io::Write;
            let hex: Vec<String> = masks.iter().map(|m| format!("\"{m:#x}\"")).collect();
            if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                let line = format!("{{\"pid\":{},\"threads\":{threads},\"claimed\":[{}]}}
", std::process::id(), hex.join(","));
                let _ = file.write_all(line.as_bytes());
            }
        }
        Some(masks)
    }

    pub(super) fn pin_current_thread(mask: usize) {
        imp::pin_current_thread(mask);
    }

    #[cfg(windows)]
    mod imp {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetLogicalProcessorInformationEx(relationship: i32, buffer: *mut u8, length: *mut u32) -> i32;
            fn GetCurrentProcess() -> isize;
            fn GetCurrentThread() -> isize;
            fn GetProcessAffinityMask(process: isize, process_mask: *mut usize, system_mask: *mut usize) -> i32;
            fn SetThreadAffinityMask(thread: isize, mask: usize) -> usize;
            fn CreateMutexW(attributes: *const u8, initial_owner: i32, name: *const u16) -> isize;
            fn WaitForSingleObject(handle: isize, millis: u32) -> u32;
            fn CloseHandle(handle: isize) -> i32;
        }
        const RELATION_PROCESSOR_CORE: i32 = 0;
        const WAIT_OBJECT_0: u32 = 0;
        const WAIT_ABANDONED_0: u32 = 0x80;

        /// (efficiency class, logical mask) of every core in processor group 0.
        fn cores() -> Option<Vec<(u8, usize)>> {
            let mut len = 0u32;
            unsafe { GetLogicalProcessorInformationEx(RELATION_PROCESSOR_CORE, std::ptr::null_mut(), &mut len) };
            if len == 0 {
                return None;
            }
            let mut buf = vec![0u8; len as usize];
            if unsafe { GetLogicalProcessorInformationEx(RELATION_PROCESSOR_CORE, buf.as_mut_ptr(), &mut len) } == 0 {
                return None;
            }
            let mut out = Vec::new();
            let mut off = 0usize;
            // SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX: Relationship u32, Size u32, then
            // PROCESSOR_RELATIONSHIP: Flags u8, EfficiencyClass u8, Reserved [u8; 20],
            // GroupCount u16, GroupMask[0]: Mask usize, Group u16.
            while off + 42 <= len as usize {
                let rel = i32::from_le_bytes(buf[off..off + 4].try_into().ok()?);
                let size = u32::from_le_bytes(buf[off + 4..off + 8].try_into().ok()?) as usize;
                if size == 0 {
                    break;
                }
                if rel == RELATION_PROCESSOR_CORE {
                    let efficiency = buf[off + 9];
                    let mask = usize::from_le_bytes(buf[off + 32..off + 40].try_into().ok()?);
                    let group = u16::from_le_bytes(buf[off + 40..off + 42].try_into().ok()?);
                    if group == 0 && mask != 0 {
                        out.push((efficiency, mask));
                    }
                }
                off += size;
            }
            Some(out)
        }

        pub(super) fn claim(threads: usize) -> Option<Vec<usize>> {
            let cores = cores()?;
            let (mut process_mask, mut system_mask) = (0usize, 0usize);
            if unsafe { GetProcessAffinityMask(GetCurrentProcess(), &mut process_mask, &mut system_mask) } == 0 {
                return None;
            }
            let fastest = cores.iter().map(|c| c.0).max()?;
            let mut claimed = Vec::new();
            for (index, &(efficiency, mask)) in cores.iter().enumerate() {
                if claimed.len() >= threads {
                    break;
                }
                let allowed = mask & process_mask;
                if efficiency != fastest || allowed == 0 {
                    continue;
                }
                let name: Vec<u16> = format!("Local\\cc2-s2-search-core-{index}").encode_utf16().chain([0]).collect();
                let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
                if handle == 0 {
                    continue;
                }
                match unsafe { WaitForSingleObject(handle, 0) } {
                    // Owned by this (the pool-creating, long-lived) thread until the process exits.
                    // The thread may use either logical CPU of its own core (the OS
                    // can dodge a busy sibling) but never shares a core with another
                    // pool thread; a single-logical pin measured slower in INPUT.
                    WAIT_OBJECT_0 | WAIT_ABANDONED_0 => claimed.push(allowed),
                    _ => {
                        unsafe { CloseHandle(handle) };
                    }
                }
            }
            Some(claimed)
        }

        pub(super) fn pin_current_thread(mask: usize) {
            unsafe { SetThreadAffinityMask(GetCurrentThread(), mask) };
        }
    }

    #[cfg(not(windows))]
    mod imp {
        pub(super) fn claim(_threads: usize) -> Option<Vec<usize>> {
            None
        }
        pub(super) fn pin_current_thread(_mask: usize) {}
    }
}

#[cfg(test)]
mod tests {
    use super::SearchPool;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[test]
    fn a_panicking_job_unwinds_on_the_caller_after_the_batch() {
        for streamed in [false, true] {
            let runs: Vec<AtomicUsize> = (0..16).map(|_| AtomicUsize::new(0)).collect();
            let ready: Vec<AtomicBool> = (0..16).map(|_| AtomicBool::new(false)).collect();
            let job = |i: usize| {
                if i == 5 {
                    panic!("job 5");
                }
                runs[i].fetch_add(1, Ordering::Relaxed);
                ready[i].store(true, Ordering::Release);
            };
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if streamed {
                    SearchPool::run_streamed(4, 16, &job, &|i| ready[i].load(Ordering::Acquire), |_| {});
                } else {
                    SearchPool::run(4, 16, &job);
                }
            }));
            assert_eq!(result.unwrap_err().downcast_ref::<&str>(), Some(&"job 5"));
            // No job runs twice, and the pool still works afterwards.
            assert!(runs.iter().all(|r| r.load(Ordering::Relaxed) <= 1));
            let after: Vec<AtomicUsize> = (0..16).map(|_| AtomicUsize::new(0)).collect();
            SearchPool::run(4, 16, &|i: usize| { after[i].fetch_add(1, Ordering::Relaxed); });
            assert!(after.iter().all(|r| r.load(Ordering::Relaxed) == 1));
        }
    }

    #[test]
    fn several_panics_with_panicking_payload_drops_still_finish_the_batch() {
        struct DropPanics;
        impl Drop for DropPanics {
            fn drop(&mut self) {
                panic!("payload drop");
            }
        }
        for streamed in [false, true] {
            let ready: Vec<AtomicBool> = (0..32).map(|_| AtomicBool::new(false)).collect();
            let job = |i: usize| {
                if i % 3 == 1 {
                    std::panic::panic_any(DropPanics);
                }
                ready[i].store(true, Ordering::Release);
            };
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if streamed {
                    SearchPool::run_streamed(4, 32, &job, &|i| ready[i].load(Ordering::Acquire), |_| {});
                } else {
                    SearchPool::run(4, 32, &job);
                }
            }));
            let payload = result.unwrap_err();
            assert!(payload.is::<DropPanics>());
            std::mem::forget(payload);
            let after: Vec<AtomicUsize> = (0..16).map(|_| AtomicUsize::new(0)).collect();
            SearchPool::run(4, 16, &|i: usize| { after[i].fetch_add(1, Ordering::Relaxed); });
            assert!(after.iter().all(|r| r.load(Ordering::Relaxed) == 1));
        }
    }

    #[test]
    fn concurrent_searches_each_run_every_job_once() {
        // Several searches of one process share the pool; each must still run
        // all of its jobs exactly once and consume them in order.
        std::thread::scope(|scope| {
            for caller in 0..4usize {
                scope.spawn(move || {
                    for round in 0..200usize {
                        let count = 3 + (caller + round) % 13;
                        let runs: Vec<AtomicUsize> = (0..count).map(|_| AtomicUsize::new(0)).collect();
                        let ready: Vec<AtomicBool> = (0..count).map(|_| AtomicBool::new(false)).collect();
                        let job = |i: usize| {
                            runs[i].fetch_add(1, Ordering::Relaxed);
                            ready[i].store(true, Ordering::Release);
                        };
                        let mut consumed = Vec::new();
                        if round % 2 == 0 {
                            SearchPool::run_streamed(4, count, &job, &|i| ready[i].load(Ordering::Acquire), |i| consumed.push(i));
                        } else {
                            SearchPool::run(4, count, &job);
                            consumed.extend(0..count);
                        }
                        assert!(runs.iter().all(|r| r.load(Ordering::Relaxed) == 1));
                        assert_eq!(consumed, (0..count).collect::<Vec<_>>());
                    }
                });
            }
        });
    }
}
