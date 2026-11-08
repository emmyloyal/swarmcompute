//! NEP-297 events. Every event carries `purchase_id` where one applies so the
//! backend indexer (contract_events.purchase_id) can join on it.
//!
//!   EVENT_JSON:{"standard":"swarmcompute","version":"1.0.0","event":"<name>","data":[{...}]}
//!
//! Amounts are decimal strings (RULES.md R3).

use near_sdk::env;
use near_sdk::serde_json::{json, Value};

pub const STANDARD: &str = "swarmcompute";
pub const VERSION: &str = "1.0.0";

pub fn emit(event: &str, data: Value) {
    let ev = json!({ "standard": STANDARD, "version": VERSION, "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{ev}"));
}
