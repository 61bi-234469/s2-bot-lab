use std::cmp::Ordering;

use serde_json::{Number, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MIN_NON_ZERO: f64 = 1e-12;
const MAX_ABS_EXCLUSIVE: f64 = 1e21;
const MAX_FRACTIONAL_DIGITS: usize = 15;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum Cs1Error {
    #[error("number is not a finite JSON number")]
    NonFiniteNumber,
    #[error("non-zero number is outside the CS/1 magnitude range")]
    NumberOutOfRange,
    #[error("number has more than 15 fractional digits")]
    TooManyFractionalDigits,
    #[error("integer cannot be represented exactly in every supported runtime")]
    UnsafeInteger,
}

impl Cs1Error {
    /// Stable wire code. The same string appears in the cross-runtime fixture
    /// and in the Node implementation, so all three runtimes report a failure
    /// by the same name instead of by prose that only matches by accident.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NonFiniteNumber => "non-finite-number",
            Self::NumberOutOfRange => "number-out-of-range",
            Self::TooManyFractionalDigits => "too-many-fractional-digits",
            Self::UnsafeInteger => "unsafe-integer",
        }
    }
}

pub fn canonicalize(value: &Value) -> Result<Vec<u8>, Cs1Error> {
    let mut output = String::new();
    write_value(value, &mut output)?;
    Ok(output.into_bytes())
}

pub fn hash(value: &Value) -> Result<String, Cs1Error> {
    let bytes = canonicalize(value)?;
    let digest = Sha256::digest(bytes);
    Ok(format!("sha256:{digest:x}"))
}

fn write_value(value: &Value, output: &mut String) -> Result<(), Cs1Error> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => output.push_str(&format_number(value)?),
        Value::String(value) => write_string(value, output),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_value(value, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            let mut entries: Vec<_> = values.iter().collect();
            entries.sort_by(|(left, _), (right, _)| compare_code_points(left, right));
            output.push('{');
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_string(key, output);
                output.push(':');
                write_value(value, output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

fn compare_code_points(left: &str, right: &str) -> Ordering {
    left.chars().cmp(right.chars())
}

fn write_string(value: &str, output: &mut String) {
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{08}' => output.push_str("\\b"),
            '\u{0c}' => output.push_str("\\f"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            character if character <= '\u{1f}' => {
                output.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => output.push(character),
        }
    }
    output.push('"');
}

fn format_number(number: &Number) -> Result<String, Cs1Error> {
    if let Some(value) = number.as_i64() {
        if value.unsigned_abs() > MAX_SAFE_INTEGER {
            return Err(Cs1Error::UnsafeInteger);
        }
        return Ok(value.to_string());
    }
    if let Some(value) = number.as_u64() {
        if value > MAX_SAFE_INTEGER {
            return Err(Cs1Error::UnsafeInteger);
        }
        return Ok(value.to_string());
    }

    let value = number.as_f64().ok_or(Cs1Error::NonFiniteNumber)?;
    if !value.is_finite() {
        return Err(Cs1Error::NonFiniteNumber);
    }
    if value == 0.0 {
        return Ok("0".to_owned());
    }
    if value.fract() == 0.0 && value.abs() > MAX_SAFE_INTEGER as f64 {
        return Err(Cs1Error::UnsafeInteger);
    }
    if value.abs() < MIN_NON_ZERO || value.abs() >= MAX_ABS_EXCLUSIVE {
        return Err(Cs1Error::NumberOutOfRange);
    }

    let plain = exponent_to_plain(&value.to_string());
    let fractional_digits = plain
        .split_once('.')
        .map_or(0, |(_, fraction)| fraction.trim_end_matches('0').len());
    if fractional_digits > MAX_FRACTIONAL_DIGITS {
        return Err(Cs1Error::TooManyFractionalDigits);
    }
    Ok(plain)
}

fn exponent_to_plain(input: &str) -> String {
    let Some((coefficient, exponent)) = input.split_once(['e', 'E']) else {
        return input.to_owned();
    };
    let exponent: i32 = exponent.parse().expect("f64 exponent is valid");
    let negative = coefficient.starts_with('-');
    let coefficient = coefficient.trim_start_matches('-');
    let mut digits = coefficient.replace('.', "");
    let decimal_at = coefficient.find('.').unwrap_or(coefficient.len()) as i32 + exponent;

    let mut plain = if decimal_at <= 0 {
        format!("0.{}{}", "0".repeat((-decimal_at) as usize), digits)
    } else if decimal_at as usize >= digits.len() {
        digits.push_str(&"0".repeat(decimal_at as usize - digits.len()));
        digits
    } else {
        digits.insert(decimal_at as usize, '.');
        digits
    };
    if negative {
        plain.insert(0, '-');
    }
    plain
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sorts_by_unicode_code_point() {
        let value = json!({"\u{10000}": "astral", "\u{e000}": "private", "a": 1});
        assert_eq!(
            String::from_utf8(canonicalize(&value).unwrap()).unwrap(),
            "{\"a\":1,\"\u{e000}\":\"private\",\"\u{10000}\":\"astral\"}"
        );
    }

    #[test]
    fn expands_exponents_and_normalizes_negative_zero() {
        assert_eq!(
            format_number(&Number::from_f64(1e-7).unwrap()).unwrap(),
            "0.0000001"
        );
        assert_eq!(
            format_number(&Number::from_f64(-0.0).unwrap()).unwrap(),
            "0"
        );
    }

    #[test]
    fn rejects_number_boundaries() {
        assert_eq!(
            format_number(&Number::from_f64(1e-13).unwrap()),
            Err(Cs1Error::NumberOutOfRange)
        );
        assert_eq!(
            format_number(&Number::from_f64(1e21).unwrap()),
            Err(Cs1Error::UnsafeInteger)
        );
        assert_eq!(
            format_number(&Number::from(9_007_199_254_740_992_u64)),
            Err(Cs1Error::UnsafeInteger)
        );
    }
}
