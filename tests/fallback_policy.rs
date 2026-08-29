use s2_analysis_engine::fallback_policy::assess_fallback;

#[path = "support/mod.rs"]
mod support;

#[test]
fn fallback_policy_matches_the_shared_golden_cases() {
    let fixture = support::FallbackFixture::load();
    assert!(!fixture.cases.is_empty());

    for case in &fixture.cases {
        let assessment = assess_fallback(
            &case.operation,
            &fixture.state_for(case),
            &fixture.engine_for(case),
            &fixture.manifest,
            case.user_selected,
        )
        .unwrap_or_else(|error| panic!("{}: {error}", case.id));

        // Comparing the serialized form rather than the struct also pins the
        // wire field names the Analysis API and the Node implementation share.
        assert_eq!(
            serde_json::to_value(assessment).unwrap(),
            case.expected,
            "{}",
            case.id
        );
    }
}
