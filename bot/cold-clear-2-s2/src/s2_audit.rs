//! Counts forbidden strategic dependencies only inside an integrated request.
use std::cell::Cell;
use serde::Serialize;
#[derive(Clone,Copy,Debug,Default,PartialEq,Serialize)]
#[serde(rename_all="camelCase")]
pub struct Audit {
    pub external_strategic_reselect_calls:u64,
    pub legacy_f14_selection_calls:u64,
    pub legacy_f14_rescue_calls:u64,
    #[serde(skip)]
    pub non_t_setup_witness_calls:u64,
    #[serde(skip)]
    pub non_t_setup_bonus_applied:u64,
    #[serde(skip)]
    pub post_stage_conversion_compute_calls:u64,
    #[serde(skip)]
    pub post_stage_conversion_add_calls:u64,
    #[serde(skip)]
    pub post_stage_rerank_calls:u64,
}
thread_local! {static ACTIVE:Cell<Option<Audit>>=Cell::new(None);}
thread_local! {static NATIVE_F14_COMPAT:Cell<bool>=Cell::new(false);}
#[cfg(test)]
thread_local! {static FORBID_LEGACY_F14:Cell<bool>=Cell::new(false);}
pub fn selection(){
    #[cfg(test)]
    if FORBID_LEGACY_F14.with(|v|v.get()){panic!("legacy F14 selector entry is forbidden in the root transport scope");}
    if NATIVE_F14_COMPAT.with(|v|v.get()){return;}
    ACTIVE.with(|v|if let Some(mut a)=v.get(){a.legacy_f14_selection_calls+=1;v.set(Some(a));});
}
pub fn rescue(){
    #[cfg(test)]
    if FORBID_LEGACY_F14.with(|v|v.get()){panic!("legacy F14 rescue entry is forbidden in the root transport scope");}
    if NATIVE_F14_COMPAT.with(|v|v.get()){return;}
    ACTIVE.with(|v|if let Some(mut a)=v.get(){a.legacy_f14_rescue_calls+=1;v.set(Some(a));});
}
pub fn non_t_setup_witness(){
    ACTIVE.with(|v|if let Some(mut a)=v.get(){a.non_t_setup_witness_calls+=1;v.set(Some(a));});
}
pub fn non_t_setup_bonus(){
    ACTIVE.with(|v|if let Some(mut a)=v.get(){a.non_t_setup_bonus_applied+=1;v.set(Some(a));});
}
fn bump_native(update:impl Fn(&mut Audit)){
    if !NATIVE_F14_COMPAT.with(|v|v.get()){return;}
    ACTIVE.with(|v|if let Some(mut a)=v.get(){update(&mut a);v.set(Some(a));});
}
pub fn post_stage_conversion_compute(){
    bump_native(|a|a.post_stage_conversion_compute_calls+=1);
}
pub fn post_stage_conversion_add(){
    bump_native(|a|a.post_stage_conversion_add_calls+=1);
}
pub fn post_stage_rerank(){
    bump_native(|a|a.post_stage_rerank_calls+=1);
}
pub fn run<T>(f:impl FnOnce()->T)->(T,Audit){
    struct Restore(Option<Audit>);
    impl Drop for Restore {fn drop(&mut self){ACTIVE.with(|v|v.set(self.0));}}
    let guard=Restore(ACTIVE.with(|v|v.replace(Some(Audit::default()))));
    let result=f();let audit=ACTIVE.with(|v|v.get().unwrap());drop(guard);(result,audit)
}
pub fn run_native_f14_compat<T>(f:impl FnOnce()->T)->(T,Audit){
    struct Restore(bool);
    impl Drop for Restore {fn drop(&mut self){NATIVE_F14_COMPAT.with(|v|v.set(self.0));}}
    let was_native=NATIVE_F14_COMPAT.with(|v|v.replace(true));
    let result=run(f);drop(Restore(was_native));result
}
#[cfg(test)]
pub fn with_legacy_selector_guard<T>(forbid:bool,f:impl FnOnce()->T)->T{
    struct Restore(bool);
    impl Drop for Restore {fn drop(&mut self){FORBID_LEGACY_F14.with(|v|v.set(self.0));}}
    let guard=Restore(FORBID_LEGACY_F14.with(|v|v.replace(forbid)));
    let result=f();drop(guard);result
}
#[cfg(not(test))]
pub fn with_legacy_selector_guard<T>(_forbid:bool,f:impl FnOnce()->T)->T{f()}
#[cfg(test)] mod tests {
    #[test] fn real_rescue_entry_is_counted_and_context_is_restored(){
        let (_,a)=super::run(||crate::f14_compat::choose_rescue(&[]));assert_eq!(a.legacy_f14_rescue_calls,1);
        crate::f14_compat::choose_rescue(&[]).ok();let (_,a)=super::run(||());assert_eq!(a.legacy_f14_rescue_calls,0);
    }
    #[test] fn native_f14_compat_does_not_look_like_legacy_selector_dispatch(){
        let (_,a)=super::run_native_f14_compat(||{
            super::selection();super::rescue();
        });
        assert_eq!(a.legacy_f14_selection_calls,0);
        assert_eq!(a.legacy_f14_rescue_calls,0);
        assert_eq!(a.external_strategic_reselect_calls,0);
    }
    #[test] fn non_t_setup_counters_count_inside_native_f14_compat(){
        let (_,a)=super::run_native_f14_compat(||{
            super::non_t_setup_witness();
            super::non_t_setup_bonus();
        });
        assert_eq!(a.non_t_setup_witness_calls,1);
        assert_eq!(a.non_t_setup_bonus_applied,1);
        let json=serde_json::to_value(a).unwrap();
        assert_eq!(json,serde_json::json!({
            "externalStrategicReselectCalls":0,
            "legacyF14SelectionCalls":0,
            "legacyF14RescueCalls":0
        }));
    }
    #[test] fn post_stage_counters_count_inside_native_f14_compat_only(){
        let (_,a)=super::run(||{
            super::post_stage_conversion_compute();
            super::post_stage_conversion_add();
            super::post_stage_rerank();
        });
        assert_eq!(a.post_stage_conversion_compute_calls,0);
        let (_,a)=super::run_native_f14_compat(||{
            super::post_stage_conversion_compute();
            super::post_stage_conversion_add();
            super::post_stage_rerank();
        });
        assert_eq!(a.post_stage_conversion_compute_calls,1);
        assert_eq!(a.post_stage_conversion_add_calls,1);
        assert_eq!(a.post_stage_rerank_calls,1);
        let json=serde_json::to_value(a).unwrap();
        assert_eq!(json.get("postStageRerankCalls"),None);
    }
}
