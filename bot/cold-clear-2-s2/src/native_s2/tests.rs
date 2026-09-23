use super::*;
use serde_json::{json, Value as Json};

fn input() -> Json {
    json!({
        "occupancy":vec![0;10], "materializedG":vec![0;10], "current":"O", "hold":null,
        "holdAvailable":true, "knownNext":["I","T"], "chain":{"combo":0,"b2b":0},
        "incoming":{"pendingRows":0,"dueThisLockRows":0}
    })
}
fn state() -> State {
    State::from_json(&input().to_string()).unwrap()
}
fn witness(s: &State, loc: PieceLocation, hold: bool) -> crate::movegen::NativeS2Move {
    s.root_moves()
        .unwrap()
        .into_iter()
        .find(|(h, m)| *h == hold && m.location == loc && m.spin == CanonicalSpin::None)
        .unwrap()
        .1
}
fn clear(lines: u32, spin: CanonicalSpin, pc: bool) -> Clear {
    Clear {
        lines,
        spin,
        perfect_clear: pc,
        cleared_any_g: false,
    }
}
fn amount(signature: Clear, pending: u32, due: u32, outgoing: u32) -> RootAmounts {
    RootAmounts {
        signature,
        outgoing_before_cancel: outgoing,
        cancelled_rows: 0,
        outgoing_after_cancel: outgoing,
        remaining_rows: pending - due,
        tank_rows: due,
        due_rows_after_lock: 0,
    }
}

#[test]
fn strict_public_admission_and_state_identity() {
    for name in ["hold", "knownNext", "incoming", "chain", "materializedG"] {
        let mut v = input();
        v.as_object_mut().unwrap().remove(name);
        assert_eq!(State::from_json(&v.to_string()), Err(Error::InvalidInput));
    }
    for (name, v) in [
        ("holeColumn", json!(7)),
        ("rngState", json!(123)),
        ("packets", json!([])),
    ] {
        let mut i = input();
        i[name] = v;
        assert_eq!(State::from_json(&i.to_string()), Err(Error::InvalidInput));
    }
    let mut v = input();
    v["incoming"]["dueThisLockRows"] = json!(1);
    assert!(State::from_json(&v.to_string()).is_err());
    v = input();
    v["materializedG"][0] = json!(1);
    assert!(State::from_json(&v.to_string()).is_err());
    v = input();
    v["occupancy"][0] = json!(1u64 << 40);
    assert!(State::from_json(&v.to_string()).is_err());
    v = input();
    v["knownNext"] = json!(vec!["I"; 101]);
    assert!(State::from_json(&v.to_string()).is_err());
    v = input();
    v["chain"] = json!({"combo":256,"b2b":5});
    v["incoming"] = json!({"pendingRows":300,"dueThisLockRows":8});
    let s = State::from_json(&v.to_string()).unwrap();
    assert_eq!(s.chain, Chain { combo: 256, b2b: 5 });
    assert_eq!(s.incoming.pending_rows, 300);
    let mut other = s.clone();
    other.chain.b2b = 4;
    assert_ne!(s, other);
    other = s.clone();
    other.horizon = Horizon::UnknownTank { rows: 8 };
    assert_ne!(s, other);
}

#[test]
fn canonical_arithmetic_fixture_parity() {
    let fixture: Json = serde_json::from_str(include_str!(
        "../../../../fixtures/diagnostics/cc2-s2-native-transition-cases.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let before = serde_json::from_value(case["before"].clone()).unwrap();
        let clear = serde_json::from_value(case["clear"].clone()).unwrap();
        let multiplier =
            parse_nonnegative_f64(case["multiplierDecimal"].as_str().unwrap()).unwrap();
        let (chain, attack) = attack(before, clear, multiplier).unwrap();
        let mut actual_chain = serde_json::to_value(chain).unwrap();
        actual_chain
            .as_object_mut()
            .unwrap()
            .remove("brokenB2bCount");
        assert_eq!(actual_chain, case["expectedChain"], "{}", case["id"]);
        let actual = serde_json::to_value(attack).unwrap();
        // Intermediate arithmetic as well as integer row stages must match.
        for (key, decimal) in [
            ("raw", "rawDecimal"),
            ("afterMultiplier", "afterMultiplierDecimal"),
        ] {
            let a = actual[key].as_f64().unwrap();
            let b = case[decimal].as_str().unwrap().parse::<f64>().unwrap();
            assert_eq!(a, b, "{} {key}", case["id"]);
        }
        for key in [
            "afterRounding",
            "specialBonus",
            "perfectClearBonus",
            "surgeChunks",
            "outgoingBeforeCancel",
        ] {
            assert_eq!(
                actual[key], case["expectedAttack"][key],
                "{} {key}",
                case["id"]
            );
        }
    }
}

#[test]
fn numeric_overflow_is_error_not_an_omitted_child() {
    for bad in ["NaN", "inf", "-1", "1e999", "garbage"] {
        assert_eq!(parse_nonnegative_f64(bad), Err(Error::InvalidInput));
    }
    assert_eq!(
        advance_chain(
            Chain {
                combo: u32::MAX,
                b2b: 0
            },
            clear(1, CanonicalSpin::None, false)
        ),
        Err(Error::NumericOverflow)
    );
    assert_eq!(
        advance_chain(
            Chain {
                combo: 0,
                b2b: u32::MAX
            },
            clear(4, CanonicalSpin::None, false)
        ),
        Err(Error::NumericOverflow)
    );
    assert_eq!(
        attack(
            Chain { combo: 0, b2b: 0 },
            clear(4, CanonicalSpin::None, true),
            f64::MAX
        ),
        Err(Error::NumericOverflow)
    );
    assert_eq!(
        attack(
            Chain { combo: 0, b2b: 0 },
            clear(0, CanonicalSpin::None, false),
            f64::NAN
        ),
        Err(Error::InvalidInput)
    );
    assert!(advance_chain(
        Chain {
            combo: u32::MAX,
            b2b: u32::MAX
        },
        clear(0, CanonicalSpin::None, false)
    )
    .is_ok());
}

#[test]
fn pc_and_materialized_g_use_canonical_board_removal() {
    let mut s = state();
    s.current = Some(Piece::I);
    s.board.cols = [15; 10];
    s.board.cols[9] = 0;
    s.materialized_g.cols[0] = 15;
    s.chain = Chain { combo: 0, b2b: 4 };
    let signature = Clear {
        lines: 4,
        spin: CanonicalSpin::None,
        perfect_clear: true,
        cleared_any_g: true,
    };
    let (_, a) = attack(s.chain, signature, 1.).unwrap();
    let (next, c, actual) = s
        .lock(
            &witness(
                &s,
                PieceLocation {
                    piece: Piece::I,
                    rotation: Rotation::East,
                    x: 9,
                    y: 2,
                },
                false,
            ),
            false,
            1.,
            &[amount(signature, 0, 0, a.outgoing_before_cancel)],
        )
        .unwrap();
    assert_eq!(c, signature);
    assert_eq!(actual, a);
    assert_eq!(next.board, Board::default());
    assert_eq!(next.materialized_g, Board::default());
    assert_eq!(next.chain, Chain { combo: 1, b2b: 5 });
    assert_eq!(actual.special_bonus, 1);
}

#[test]
fn hold_consumption_and_terminal_tank_preserve_legal_move() {
    let s = state();
    let sig = clear(0, CanonicalSpin::None, false);
    let loc = PieceLocation {
        piece: Piece::O,
        rotation: Rotation::North,
        x: 4,
        y: 0,
    };
    let (next, _, _) = s
        .lock(&witness(&s, loc, false), false, 1., &[amount(sig, 0, 0, 0)])
        .unwrap();
    assert_eq!(next.current, Some(Piece::I));
    assert_eq!(next.hold, None);
    let i = PieceLocation {
        piece: Piece::I,
        rotation: Rotation::North,
        x: 4,
        y: 0,
    };
    let (next, _, _) = s
        .lock(&witness(&s, i, true), true, 1., &[amount(sig, 0, 0, 0)])
        .unwrap();
    assert_eq!(next.hold, Some(Piece::O));
    assert_eq!(next.current, Some(Piece::T));
    let mut blocked = s.clone();
    blocked.hold_available = false;
    assert_eq!(
        blocked.lock(&witness(&s, i, true), true, 1., &[amount(sig, 0, 0, 0)]),
        Err(Error::IllegalPlacement)
    );
    let mut tank = s;
    tank.incoming = Incoming {
        pending_rows: 300,
        due_this_lock_rows: 40,
    };
    let (leaf, _, _) = tank
        .lock(
            &witness(&tank, loc, false),
            false,
            1.,
            &[amount(sig, 300, 40, 0)],
        )
        .unwrap();
    assert_eq!(leaf.horizon, Horizon::UnknownTank { rows: 40 });
    assert_eq!(leaf.board.cols[4], 3); // no invented 40-row future board / prune
    assert_eq!(classify_root(true, 1, true, false), RootStatus::Move);
    assert!(leaf
        .lock(
            &witness(&tank, loc, false),
            false,
            1.,
            &[amount(sig, 260, 0, 0)]
        )
        .is_err());
}

#[test]
fn no_move_is_distinct_from_incomplete_and_finite_tree_complete() {
    assert_eq!(
        classify_root(false, 0, false, false),
        RootStatus::Incomplete
    );
    assert_eq!(classify_root(true, 0, false, true), RootStatus::RootNoMove);
    assert_eq!(classify_root(true, 3, false, true), RootStatus::Move);
    assert_eq!(classify_root(true, 3, false, false), RootStatus::Incomplete);
}

#[test]
fn only_the_generated_signature_is_read_from_the_root_amount_table() {
    let s = state();
    let mv = witness(
        &s,
        PieceLocation {
            piece: Piece::O,
            rotation: Rotation::North,
            x: 4,
            y: 0,
        },
        false,
    );
    let matching = amount(clear(0, CanonicalSpin::None, false), 0, 0, 0);
    let expected = s.lock(&mv, false, 1., &[matching]).unwrap();
    let unused = amount(clear(4, CanonicalSpin::Normal, true), 0, 0, 999);
    assert_eq!(
        s.lock(&mv, false, 1., &[unused, matching]).unwrap(),
        expected
    );
    assert_eq!(s.lock(&mv, false, 1., &[]), Err(Error::OracleMismatch));
    assert_eq!(
        s.lock(&mv, false, 1., &[matching, matching]),
        Err(Error::OracleMismatch)
    );
}

#[test]
fn terminal_loss_is_lower_than_any_finite_eval_and_rewards_are_edge_owned() {
    for n in [-1000., -1025., -1565., -f64::MAX] {
        assert!(Value::LOSS < Value::finite(n).unwrap());
    }
    for n in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert!(Value::finite(n).is_err());
    }
    assert!(Value::finite(f64::MAX)
        .unwrap()
        .add_reward(f64::MAX)
        .is_err());
    assert!(Value::LOSS.add_reward(f64::NAN).is_err());
    let child = Value::finite(-1025.).unwrap();
    assert_eq!(
        child.add_reward(5.).unwrap(),
        Value::finite(-1020.).unwrap()
    );
    assert_eq!(
        child.add_reward(20.).unwrap(),
        Value::finite(-1005.).unwrap()
    );
    assert_eq!(child, Value::finite(-1025.).unwrap());
    assert_eq!(Value::best(std::iter::empty()), Value::LOSS);
    assert_eq!(Value::best([Value::LOSS, child].into_iter()), child);
    assert_eq!(Value::LOSS.diagnostic(), json!({"kind":"terminal-loss"}));
}

#[test]
fn spin_classifier_uses_rotation_evidence_not_native_spin_label() {
    let mut b = Board::default();
    b.cols[3] = 5;
    b.cols[5] = 5;
    let target = PieceLocation {
        piece: Piece::T,
        rotation: Rotation::North,
        x: 4,
        y: 1,
    };
    assert_eq!(
        spin_from_evidence(&b, target, true, Rotation::East, (0, 0)),
        CanonicalSpin::Normal
    );
    assert_eq!(
        spin_from_evidence(&b, target, false, Rotation::East, (0, 0)),
        CanonicalSpin::None
    );
    b.cols[5] = 1;
    assert_eq!(
        spin_from_evidence(&b, target, true, Rotation::East, (0, 0)),
        CanonicalSpin::Mini
    );
}

#[test]
fn canonical_spin_golden_and_all_mini_plus_precedence() {
    let fixture: Json = serde_json::from_str(include_str!(
        "../../../../fixtures/golden/spin-placement.json"
    ))
    .unwrap();
    let board_from_rows = |rows: &Json| {
        let mut board = Board::default();
        for (y, row) in rows.as_array().unwrap().iter().enumerate() {
            for (x, c) in row.as_str().unwrap().chars().enumerate() {
                if c != '_' {
                    board.cols[x] |= 1u64 << y;
                }
            }
        }
        board
    };
    for c in fixture["cases"].as_array().unwrap() {
        if c.get("expectedError").is_some() {
            continue;
        } // rejection belongs to witness validation, not this pure classifier
        let rotation = match c["rotation"].as_str().unwrap() {
            "spawn" => Rotation::North,
            "left" => Rotation::West,
            "right" => Rotation::East,
            "reverse" => Rotation::South,
            _ => unreachable!(),
        };
        let from = match c["kickId"].as_str().unwrap().as_bytes()[0] {
            b'0' => Rotation::North,
            b'1' => Rotation::East,
            b'2' => Rotation::South,
            b'3' => Rotation::West,
            _ => unreachable!(),
        };
        let target = PieceLocation {
            piece: Piece::T,
            rotation,
            x: 4,
            y: 1,
        };
        let spin = spin_from_evidence(
            &board_from_rows(&c["boardRows"]),
            target,
            true,
            from,
            (
                c["kickOffset"][0].as_i64().unwrap() as i8,
                c["kickOffset"][1].as_i64().unwrap() as i8,
            ),
        );
        assert_eq!(
            serde_json::to_value(spin).unwrap(),
            c["expectedSpin"],
            "{}",
            c["id"]
        );
    }
    let fixture: Json = serde_json::from_str(include_str!(
        "../../../../fixtures/golden/all-spin-placement.json"
    ))
    .unwrap();
    for (piece, key) in [
        (Piece::O, "immobileBoardRows"),
        (Piece::T, "tImmobileWithoutCornersBoardRows"),
    ] {
        assert_eq!(
            spin_from_evidence(
                &board_from_rows(&fixture[key]),
                PieceLocation {
                    piece,
                    rotation: Rotation::North,
                    x: 4,
                    y: 1
                },
                true,
                Rotation::North,
                (0, 0)
            ),
            CanonicalSpin::Mini
        );
    }
}

#[test]
fn witness_frontier_preserves_legacy_and_binds_source_board() {
    let s = state();
    for piece in [
        Piece::I,
        Piece::O,
        Piece::T,
        Piece::J,
        Piece::L,
        Piece::S,
        Piece::Z,
    ] {
        let before = crate::movegen::find_moves_complete(&s.board, piece, true);
        let moves = crate::movegen::find_native_s2_moves(
            &s.board,
            piece,
            crate::movegen::RootEntry::Normal,
        );
        assert!(!moves.is_empty());
        for m in &moves {
            assert!(!m.location.obstructed(&s.board));
            assert_eq!(m.location.drop_distance(&s.board), 0);
            if let Some(from) = m.rotation_from {
                assert!(!from.obstructed(&s.board));
                assert!(m.native_kick_index.is_some());
                assert_eq!(
                    m.spin,
                    spin_from_evidence(
                        &s.board,
                        m.location,
                        true,
                        from.rotation,
                        m.native_kick_offset.unwrap()
                    )
                );
            } else {
                assert_eq!(m.spin, CanonicalSpin::None);
            }
        }
        for (legacy, _) in &before.moves {
            assert!(moves
                .iter()
                .any(|m| m.location.canonical_form() == legacy.location.canonical_form()));
        }
        assert_eq!(
            before,
            crate::movegen::find_moves_complete(&s.board, piece, true)
        );
    }
    let proof = witness(
        &s,
        PieceLocation {
            piece: Piece::O,
            rotation: Rotation::North,
            x: 4,
            y: 0,
        },
        false,
    );
    let mut changed = s.clone();
    changed.board.cols[0] = 1;
    assert_eq!(
        changed.lock(
            &proof,
            false,
            1.,
            &[amount(clear(0, CanonicalSpin::None, false), 0, 0, 0)]
        ),
        Err(Error::IllegalPlacement)
    );
    let mut blocked = s;
    blocked.board.cols = [(1u64 << 40) - 1; 10];
    assert!(blocked.root_moves().unwrap().is_empty());
}
