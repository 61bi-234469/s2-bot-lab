use std::sync::mpsc::{self, SyncSender};
use std::time::Instant;

use parking_lot::{Condvar, Mutex, RwLock};

use crate::bot::{Bot, Statistics};
use crate::data::{Piece, Placement};
use crate::tbp::MoveInfo;

pub struct BotSyncronizer {
    state: Mutex<State>,
    blocker: Condvar,
    bot: RwLock<Option<Bot>>,
    // Destroying a mature DAG can take long enough to stall the protocol
    // thread. Hand retired bots to this dedicated owner, but use a rendezvous
    // channel so at most one old DAG is being reclaimed. An unbounded backlog
    // retains one mature DAG per suggestion and can exhaust host memory.
    retired_bots: SyncSender<Bot>,
}

impl BotSyncronizer {
    pub fn new() -> Self {
        BotSyncronizer {
            state: Mutex::new(State {
                stats: Default::default(),
                last_advance: Instant::now(),
                selection_limit: u64::MAX,
                start: Instant::now(),
                nodes_since_start: 0,
            }),
            blocker: Condvar::new(),
            bot: RwLock::new(None),
            retired_bots: spawn_retirement_reclaimer(),
        }
    }

    pub fn start(&self, initial_state: Bot) {
        let retired = {
            let mut state = self.state.lock();
            state.stats = Default::default();
            state.nodes_since_start = 0;
            state.start = Instant::now();
            state.selection_limit = initial_state.search_selection_limit();
            let retired = {
                let mut bot = self.bot.write();
                std::mem::replace(&mut *bot, Some(initial_state))
            };
            self.blocker.notify_all();
            retired
        };
        // A rendezvous send can wait for the reclaimer. Never do that while
        // holding state or bot locks, or a slow DAG destruction would block
        // workers and suggestions behind those locks.
        self.reclaim(retired);
    }

    pub fn stop(&self) {
        let retired = self.bot.write().take();
        self.reclaim(retired);
        self.blocker.notify_all();
    }

    pub fn suggest(&self) -> (Vec<Placement>, MoveInfo) {
        let mut state = self.state.lock();
        while state.selection_limit != u64::MAX && state.stats.selections < state.selection_limit {
            if self.bot.read().is_none() {
                return (Vec::new(), empty_move_info());
            }
            self.blocker.wait(&mut state);
        }
        let stats = state.stats;
        let nps = stats.nodes as f64 / state.last_advance.elapsed().as_secs_f64();
        let extra = format!(
            "{:.1}% of selections expanded, overall speed: {:.1} Mnps",
            stats.expansions as f64 / stats.selections as f64 * 100.0,
            state.nodes_since_start as f64 / state.start.elapsed().as_secs_f64() / 1_000_000.0
        );
        drop(state);

        let bot = self.bot.read();
        match bot.as_ref() {
            Some(bot) => {
                let candidates = bot.suggest();
                let (moves, candidate_values): (Vec<_>, Vec<_>) = candidates.into_iter().unzip();
                let info = MoveInfo {
                    nodes: stats.nodes,
                    selections: stats.selections,
                    candidate_values,
                    nps,
                    extra,
                };
                (moves, info)
            }
            // A stop can win the race after the fixed-budget wait above.  The
            // protocol must still answer every Suggest request: a silent
            // process is indistinguishable from a hung one to its frontend.
            None => (Vec::new(), empty_move_info()),
        }
    }

    fn reclaim(&self, bot: Option<Bot>) {
        if let Some(bot) = bot {
            // The receiver lasts for the synchronizer's lifetime.  If it has
            // unexpectedly stopped, dropping here is the only safe fallback.
            let _ = self.retired_bots.send(bot);
        }
    }

    pub fn advance(&self, mv: Placement) {
        let mut state = self.state.lock();
        state.stats = Default::default();
        state.last_advance = Instant::now();
        let mut bot = self.bot.write();
        if let Some(bot) = &mut *bot {
            bot.advance(mv);
        }
        self.blocker.notify_all();
    }

    pub fn new_piece(&self, piece: Piece) {
        let mut bot = self.bot.write();
        if let Some(bot) = &mut *bot {
            bot.new_piece(piece);
        }
        self.blocker.notify_all();
    }

    pub fn work_loop(&self) {
        let mut state = self.state.lock();
        loop {
            if state.stats.selections >= state.selection_limit {
                self.blocker.wait(&mut state);
                continue;
            }
            let bot_guard = self.bot.read();
            let bot = match &*bot_guard {
                Some(bot) => bot,
                None => {
                    drop(bot_guard);
                    self.blocker.wait(&mut state);
                    continue;
                }
            };

            drop(state);
            let new_stats = bot.do_work();
            drop(bot_guard);

            state = self.state.lock();
            state.stats.accumulate(new_stats);
            state.nodes_since_start += new_stats.nodes;
            self.blocker.notify_all();
        }
    }
}

fn spawn_retirement_reclaimer<T: Send + 'static>() -> SyncSender<T> {
    // A zero-capacity channel allows one value to be in Drop, but no queue of
    // additional values. The next retirement waits until that Drop completes.
    let (sender, receiver) = mpsc::sync_channel(0);
    std::thread::spawn(move || {
        while let Ok(value) = receiver.recv() {
            drop(value);
        }
    });
    sender
}

fn empty_move_info() -> MoveInfo {
    MoveInfo {
        nodes: 0,
        selections: 0,
        candidate_values: Vec::new(),
        nps: 0.0,
        extra: "no active bot".to_owned(),
    }
}

#[derive(Copy, Clone, Debug)]
struct State {
    stats: Statistics,
    last_advance: Instant,
    selection_limit: u64,
    start: Instant,
    nodes_since_start: u64,
}

#[cfg(test)]
mod tests {
    use super::spawn_retirement_reclaimer;
    use super::BotSyncronizer;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    struct BlockOnDrop {
        started: Option<mpsc::Sender<()>>,
        release: Option<mpsc::Receiver<()>>,
    }

    impl BlockOnDrop {
        fn blocking(started: mpsc::Sender<()>, release: mpsc::Receiver<()>) -> Self {
            Self {
                started: Some(started),
                release: Some(release),
            }
        }

        fn immediate() -> Self {
            Self {
                started: None,
                release: None,
            }
        }
    }

    impl Drop for BlockOnDrop {
        fn drop(&mut self) {
            if let Some(started) = self.started.take() {
                started.send(()).unwrap();
                self.release.take().unwrap().recv().unwrap();
            }
        }
    }

    #[test]
    fn suggest_without_an_active_bot_returns_an_empty_protocol_result() {
        let bot = BotSyncronizer::new();
        let (moves, info) = bot.suggest();

        assert!(moves.is_empty());
        assert_eq!(info.nodes, 0);
        assert_eq!(info.selections, 0);
        assert_eq!(info.extra, "no active bot");
    }

    #[test]
    fn retirement_reclaimer_does_not_queue_a_second_mature_value() {
        let reclaimer = spawn_retirement_reclaimer();
        let (drop_started, drop_started_rx) = mpsc::channel();
        let (release_drop, release_drop_rx) = mpsc::channel();
        reclaimer
            .send(BlockOnDrop::blocking(drop_started, release_drop_rx))
            .unwrap();
        drop_started_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();

        let (second_sent, second_sent_rx) = mpsc::channel();
        let second_reclaimer = reclaimer.clone();
        let sender = thread::spawn(move || {
            second_reclaimer.send(BlockOnDrop::immediate()).unwrap();
            second_sent.send(()).unwrap();
        });

        assert!(second_sent_rx
            .recv_timeout(Duration::from_millis(50))
            .is_err());
        release_drop.send(()).unwrap();
        second_sent_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        sender.join().unwrap();
    }
}
