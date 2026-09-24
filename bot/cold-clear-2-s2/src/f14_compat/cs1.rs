use serde_json::{Map, Number, Value};
use std::cmp::Ordering;

const MIN_NON_ZERO: f64 = 1e-12;
const MAX_ABS_EXCLUSIVE: f64 = 1e21;
const MAX_FRACTIONAL_DIGITS: usize = 15;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cs1Error {
    NonFiniteNumber,
    UnsafeInteger,
    NumberOutOfRange,
    TooManyFractionalDigits,
    UnsupportedType,
}

impl Cs1Error {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NonFiniteNumber => "non-finite-number",
            Self::UnsafeInteger => "unsafe-integer",
            Self::NumberOutOfRange => "number-out-of-range",
            Self::TooManyFractionalDigits => "too-many-fractional-digits",
            Self::UnsupportedType => "unsupported-type",
        }
    }
}

pub fn canonicalize(value: &Value) -> Result<String, Cs1Error> {
    let mut output = String::new();
    write_value(value, &mut output)?;
    Ok(output)
}

fn write_value(value: &Value, output: &mut String) -> Result<(), Cs1Error> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(true) => output.push_str("true"),
        Value::Bool(false) => output.push_str("false"),
        Value::Number(number) => output.push_str(&format_number(number)?),
        Value::String(text) => write_string(text, output),
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
        Value::Object(values) => write_object(values, output)?,
    }
    Ok(())
}

fn write_object(values: &Map<String, Value>, output: &mut String) -> Result<(), Cs1Error> {
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
    let value = number.as_f64().ok_or(Cs1Error::NonFiniteNumber)?;
    if !value.is_finite() {
        return Err(Cs1Error::NonFiniteNumber);
    }
    if value.fract() == 0.0 && value.abs() > MAX_SAFE_INTEGER {
        return Err(Cs1Error::UnsafeInteger);
    }
    if value == 0.0 {
        return Ok("0".to_owned());
    }
    if value.abs() < MIN_NON_ZERO || value.abs() >= MAX_ABS_EXCLUSIVE {
        return Err(Cs1Error::NumberOutOfRange);
    }
    let plain = exponent_to_plain(&value.to_string());
    let fraction = plain
        .split_once('.')
        .map(|(_, rest)| rest.trim_end_matches('0').len())
        .unwrap_or(0);
    if fraction > MAX_FRACTIONAL_DIGITS {
        return Err(Cs1Error::TooManyFractionalDigits);
    }
    Ok(plain)
}

fn exponent_to_plain(input: &str) -> String {
    let Some((coefficient, exponent)) = input.split_once(['e', 'E']) else {
        return input.to_owned();
    };
    let exponent: i32 = exponent.parse().expect("f64 exponent");
    let negative = coefficient.starts_with('-');
    let unsigned = coefficient.trim_start_matches('-');
    let digits = unsigned.replace('.', "");
    let decimal_at = unsigned.find('.').unwrap_or(unsigned.len()) as i32 + exponent;
    let mut plain = if decimal_at <= 0 {
        format!("0.{}{}", "0".repeat((-decimal_at) as usize), digits)
    } else if decimal_at as usize >= digits.len() {
        let mut expanded = digits;
        expanded.push_str(&"0".repeat(decimal_at as usize - expanded.len()));
        expanded
    } else {
        let mut expanded = digits;
        expanded.insert(decimal_at as usize, '.');
        expanded
    };
    if negative {
        plain.insert(0, '-');
    }
    plain
}
