fn main() {
    // This vendored crate deliberately identifies the immutable upstream base
    // instead of accidentally reporting the parent repository's Git HEAD.
    println!("cargo:rustc-env=GIT_HASH=s2-ed8b193");
}
