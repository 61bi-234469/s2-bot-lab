#[cfg(not(target_arch = "wasm32"))]
mod native {
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

    /// Explicit ADR-063 process profile JSON; never enables the GUI/default route
    #[structopt(long)]
    native_profile: Option<String>,

    /// Explicit schema 2 shared CC2/S2 profile; unqualified, opt-in only
    #[structopt(long)]
    integrated_profile: Option<String>,

    /// Development-only F14 amount-only compat profile JSON; never enables ADR-063
    #[structopt(long)]
    f14_compat_profile: Option<String>,

    /// Path to JSON file containing the bot configuration
    #[structopt(short, long)]
    config: Option<PathBuf>,

    /// Stop after exactly this many tree selections and block suggest until done
    #[structopt(long)]
    search_selection_limit: Option<u64>,

    /// Seed for deterministic tree exploration
    #[structopt(long)]
    search_seed: Option<u64>,
}

pub fn run() {
    let options = CliOptions::from_args();
    if [options.native_profile.is_some(),options.f14_compat_profile.is_some(),options.integrated_profile.is_some()].iter().filter(|v|**v).count()>1 {
        eprintln!("native and F14 compat profiles are mutually exclusive");
        std::process::exit(2);
    }
    if let Some(raw) = &options.integrated_profile {
        let profile = serde_json::from_str::<cold_clear_2_s2::s2_transport::Profile>(raw);
        match profile {
            Ok(profile) if profile.valid() && options.config.is_none() && options.search_seed.is_none()
                && options.search_selection_limit.is_none() => {
                if let Err(error) = cold_clear_2_s2::run_integrated(profile) { eprintln!("integrated I/O: {error}"); std::process::exit(2); }
            },
            _ => { eprintln!("invalid integrated process profile or legacy overrides"); std::process::exit(2); }
        }
        return;
    }
    if let Some(raw) = &options.native_profile {
        let profile = serde_json::from_str::<cold_clear_2_s2::native_s2::transport::Profile>(raw);
        match profile {
            Ok(profile) if profile.valid() && options.config.is_none() && options.search_seed.is_none()
                && options.search_selection_limit.is_none() => {
                if let Err(error) = cold_clear_2_s2::run_native(profile) { eprintln!("native I/O: {error}"); }
            },
            _ => { eprintln!("invalid native process profile or legacy overrides"); std::process::exit(2); }
        }
        return;
    }
    if let Some(raw) = &options.f14_compat_profile {
        let profile = serde_json::from_str::<cold_clear_2_s2::f14_compat::transport::Profile>(raw);
        match profile {
            Ok(profile) if profile.valid() && options.config.is_none() && options.search_seed.is_none()
                && options.search_selection_limit.is_none() => {
                if let Err(error) = cold_clear_2_s2::run_f14(profile) { eprintln!("f14 I/O: {error}"); }
            },
            _ => { eprintln!("invalid F14 compat profile or legacy overrides"); std::process::exit(2); }
        }
        return;
    }

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

    let mut config: cold_clear_2_s2::BotConfig =
        options.config.map_or_else(Default::default, |path| {
            let f = BufReader::new(File::open(path).unwrap());
            serde_json::from_reader(f).unwrap()
        });
    if let Some(limit) = options.search_selection_limit {
        assert!(limit > 0, "search selection limit must be positive");
        config.search_selection_limit = limit;
    }
    if let Some(seed) = options.search_seed {
        config.search_seed = seed;
    }
    let config = Arc::new(config);

    let stdin=std::io::stdin();
    let mut input=stdin.lock();
    let incoming = futures::stream::iter(std::iter::from_fn(||cold_clear_2_s2::read_frontend_message(&mut input)));

    let outgoing = futures::sink::unfold((), |_, msg| {
        serde_json::to_writer(std::io::stdout(), &msg).unwrap();
        println!();
        async { Ok(()) }
    });

    futures::pin_mut!(incoming);
    futures::pin_mut!(outgoing);

    futures::executor::block_on(cold_clear_2_s2::run(incoming, outgoing, config));
}

}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    native::run();
}

#[cfg(target_arch = "wasm32")]
fn main() {}
