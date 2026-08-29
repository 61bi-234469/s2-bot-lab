#![no_std]

#[macro_export]
macro_rules! profile_function { () => {}; }

#[macro_export]
macro_rules! profile_scope { ($($token:tt)*) => {}; }
