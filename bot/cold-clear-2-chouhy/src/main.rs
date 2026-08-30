use std::fs::File;
use std::io::BufReader;
use std::path::PathBuf;
use std::sync::Arc;

use structopt::StructOpt;

#[derive(StructOpt)]
struct CliOptions {
    /// Enable puffin profiler (requires building with feature `puffin_http`)
    #[structopt(long)]
    profile: bool,

    /// Path to JSON file containing the bot configuration
    #[structopt(short, long)]
    config: Option<PathBuf>,

    #[structopt(long)]
    search_selection_limit: Option<u64>,

    #[structopt(long)]
    search_seed: Option<u64>,
}

fn main() {
    let options = CliOptions::from_args();

    #[cfg(feature = "puffin_http")]
    let _puffin_server = match options.profile {
        true => {
            puffin::set_scopes_on(true);
            Some(puffin_http::Server::new(&format!(
                "0.0.0.0:{}",
                puffin_http::DEFAULT_PORT
            )))
        }
        false => None,
    };

    let mut config: cold_clear_2_chouhy::BotConfig = options.config.map_or_else(Default::default, |path| {
        let f = BufReader::new(File::open(path).unwrap());
        serde_json::from_reader(f).unwrap()
    });
    if let Some(limit) = options.search_selection_limit {
        assert!(limit > 0, "search selection limit must be positive");
        config.search_selection_limit = limit;
    }
    if let Some(seed) = options.search_seed { config.search_seed = seed; }
    let config = Arc::new(config);

    let incoming = futures::stream::repeat_with(|| {
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    });

    let outgoing = futures::sink::unfold((), |_, msg| {
        serde_json::to_writer(std::io::stdout(), &msg).unwrap();
        println!();
        async { Ok(()) }
    });

    futures::pin_mut!(incoming);
    futures::pin_mut!(outgoing);

    futures::executor::block_on(cold_clear_2_chouhy::run(incoming, outgoing, config));
}
