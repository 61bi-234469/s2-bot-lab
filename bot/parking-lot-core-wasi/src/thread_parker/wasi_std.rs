// s2-bot-lab patch: a thread parker for wasm32-wasip1-threads on stable Rust (see UPSTREAM.md),
// built on std::thread::park / Thread::unpark (std implements them with the wasm atomic wait / notify).
use instant::Instant;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, Thread};

pub struct ThreadParker {
    parked: AtomicBool,
    thread: Thread,
}

impl super::ThreadParkerT for ThreadParker {
    type UnparkHandle = UnparkHandle;

    const IS_CHEAP_TO_CONSTRUCT: bool = false;

    fn new() -> ThreadParker {
        ThreadParker { parked: AtomicBool::new(false), thread: thread::current() }
    }

    unsafe fn prepare_park(&self) {
        self.parked.store(true, Ordering::Relaxed);
    }

    unsafe fn timed_out(&self) -> bool {
        self.parked.load(Ordering::Relaxed)
    }

    unsafe fn park(&self) {
        while self.parked.load(Ordering::Acquire) {
            thread::park();
        }
    }

    unsafe fn park_until(&self, timeout: Instant) -> bool {
        while self.parked.load(Ordering::Acquire) {
            let now = Instant::now();
            if timeout <= now {
                return false;
            }
            thread::park_timeout(timeout - now);
        }
        true
    }

    unsafe fn unpark_lock(&self) -> UnparkHandle {
        // Clear the flag first; the handle then wakes the thread (a spurious unpark only makes park re-check).
        self.parked.store(false, Ordering::Release);
        UnparkHandle(self.thread.clone())
    }
}

pub struct UnparkHandle(Thread);

impl super::UnparkHandleT for UnparkHandle {
    unsafe fn unpark(self) {
        self.0.unpark();
    }
}

pub fn thread_yield() {
    thread::yield_now();
}
