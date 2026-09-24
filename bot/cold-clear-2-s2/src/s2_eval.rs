//! Versioned S2 H/R components. Shared canonical rules and geometry only;
//! the legacy completed evaluator, selector and rescue are never called here.
use crate::data::{Board, Piece};
use crate::native_s2::{self, CanonicalSpin, Chain, Error};
use crate::s2_core::{Action, Context, State, Transition};
use serde::{Deserialize, Serialize};

pub const FEATURE_VERSION: &str = "s2-cc2-h-r-features/1";
pub const STRUCTURE_FEATURE_VERSION: &str = "s2-cc2-h-r-features/2";
pub const STRUCTURE_PREVIEW_FEATURE_VERSION: &str = "s2-cc2-h-r-features/3";
pub const COMMITTED_WELL_FEATURE_VERSION: &str = "s2-cc2-h-r-features/4";

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct PolicyInput {
    pub feature_version: String,
    pub geometry: Vec<String>,
    pub out: String, pub cancel: String, pub conversion: String, pub tank: String,
    pub soft: String, pub waste_t: String, pub b2b: String, pub pending: String, pub margin: String,
    pub exploration: String,
    pub risk_enabled: bool,
    #[serde(default, skip_serializing_if="Option::is_none")]
    pub action_reward: Option<ActionRewardInput>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct ActionRewardInput {
    pub schema: String,
    pub group: String,
    pub table: Vec<String>,
    pub scale: String,
    pub number_format: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct NormalClearReward {
    table: [f64; 5],
    scale: f64,
}

const ACTION_REWARD_SCHEMA: &str = "s2-cc2-action-reward/1";
const ACTION_REWARD_NUMBER_FORMAT: &str = "f32-then-f64";
const NORMAL_CLEAR_TABLE_TOKENS: [&str; 5] = ["0.0", "0.8", "1.6", "2.3", "2.8"];
const NORMAL_CLEAR_F32_BITS: [u32; 5] = [0x00000000, 0x3f4ccccd, 0x3fcccccd, 0x40133333, 0x40333333];

fn parse_action_reward(input: &PolicyInput) -> Result<Option<NormalClearReward>, Error> {
    let Some(action) = &input.action_reward else { return Ok(None); };
    if action.schema != ACTION_REWARD_SCHEMA || action.number_format != ACTION_REWARD_NUMBER_FORMAT
        || action.table.len() != NORMAL_CLEAR_TABLE_TOKENS.len() || action.scale.trim() != action.scale {
        return Err(Error::InvalidInput);
    }
    let mut table = [0.0; 5];
    for index in 0..5 {
        if action.table[index] != NORMAL_CLEAR_TABLE_TOKENS[index] { return Err(Error::InvalidInput); }
        let value = action.table[index].parse::<f32>().map_err(|_| Error::InvalidInput)?;
        if !value.is_finite() || value.to_bits() != NORMAL_CLEAR_F32_BITS[index] { return Err(Error::InvalidInput); }
        table[index] = f64::from(value);
    }
    let scale = action.scale.parse::<f64>().map_err(|_| Error::InvalidInput)?;
    if !scale.is_finite() || !(0.0..=100.0).contains(&scale) { return Err(Error::InvalidInput); }
    match action.group.as_str() {
        "disabled" => Ok(None),
        "normal-clear-v1" => Ok(Some(NormalClearReward { table, scale })),
        _ => Err(Error::InvalidInput),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StructuralBoardSource {
    Base,
    CommittedPreview,
    CommittedPreviewWell,
}

#[derive(Clone, Copy)]
enum GeometryWeights { V1([f64;9]), V2([f64;13]), V3([f64;14]) }
impl GeometryWeights {
    fn values(&self)->&[f64] {match self {Self::V1(v)=>v,Self::V2(v)=>v,Self::V3(v)=>v}}
}

pub struct Policy {
    geometry: GeometryWeights,
    structural_board: Option<StructuralBoardSource>,
    edge: [f64;6],
    state: [f64;3],
    exploration: f64,
    risk_enabled: bool,
    normal_clear_reward: Option<NormalClearReward>,
}
impl Policy {
    pub fn new(input:&PolicyInput)->Result<Self,Error> {
        let parse=|s:&str| -> Result<f64,Error> {
            let n=s.parse::<f64>().map_err(|_|Error::InvalidInput)?;
            if n.is_finite()&&n.abs()<=1_000_000.0 {Ok(n)}else{Err(Error::InvalidInput)}
        };
        let structural_board=match input.feature_version.as_str() {
            FEATURE_VERSION if input.geometry.len()==9=>None,
            STRUCTURE_FEATURE_VERSION if input.geometry.len()==13=>Some(StructuralBoardSource::Base),
            STRUCTURE_PREVIEW_FEATURE_VERSION if input.geometry.len()==13=>Some(StructuralBoardSource::CommittedPreview),
            COMMITTED_WELL_FEATURE_VERSION if input.geometry.len()==14=>Some(StructuralBoardSource::CommittedPreviewWell),
            _=>return Err(Error::InvalidInput),
        };
        let geometry=match input.feature_version.as_str() {
            FEATURE_VERSION => GeometryWeights::V1(input.geometry.iter().map(|w|parse(w)).collect::<Result<Vec<_>,_>>()?.try_into().map_err(|_|Error::InvalidInput)?),
            STRUCTURE_FEATURE_VERSION|STRUCTURE_PREVIEW_FEATURE_VERSION => GeometryWeights::V2(input.geometry.iter().map(|w|parse(w)).collect::<Result<Vec<_>,_>>()?.try_into().map_err(|_|Error::InvalidInput)?),
            COMMITTED_WELL_FEATURE_VERSION => GeometryWeights::V3(input.geometry.iter().map(|w|parse(w)).collect::<Result<Vec<_>,_>>()?.try_into().map_err(|_|Error::InvalidInput)?),
            _ => return Err(Error::InvalidInput),
        };
        let edge=[parse(&input.out)?,parse(&input.cancel)?,parse(&input.conversion)?,parse(&input.tank)?,parse(&input.soft)?,parse(&input.waste_t)?];
        let state=[parse(&input.b2b)?,parse(&input.pending)?,parse(&input.margin)?];
        let exploration=parse(&input.exploration)?;
        let normal_clear_reward=parse_action_reward(input)?;
        if edge[..3].iter().any(|v|*v<0.)||edge[3..].iter().any(|v|*v>0.)
            ||state[0]<0.||state[1]>0.||state[2]<0.||exploration<1e-6 {return Err(Error::InvalidInput);}
        Ok(Self {geometry,structural_board,edge,state,exploration,risk_enabled:input.risk_enabled,normal_clear_reward})
    }
    pub fn feature_version(&self)->&'static str {match self.structural_board {
        None=>FEATURE_VERSION,
        Some(StructuralBoardSource::Base)=>STRUCTURE_FEATURE_VERSION,
        Some(StructuralBoardSource::CommittedPreview)=>STRUCTURE_PREVIEW_FEATURE_VERSION,
        Some(StructuralBoardSource::CommittedPreviewWell)=>COMMITTED_WELL_FEATURE_VERSION,
    }}
    pub fn exploration(&self)->f64 {self.exploration}
    pub fn risk_enabled(&self)->bool {self.risk_enabled}
    pub fn action_reward_enabled(&self)->bool {self.normal_clear_reward.is_some()}
    pub(crate) fn normal_clear_detail(&self,features:&EdgeFeatures)->Option<(f64,f64)> {
        let reward=self.normal_clear_reward?;
        if features.canonical_spin!=CanonicalSpin::None||features.perfect_clear||features.clear_lines==0||features.clear_lines>4 {return None;}
        let units=reward.table[features.clear_lines as usize];
        let contribution=units*reward.scale;
        if units.is_finite()&&contribution.is_finite(){Some((units,contribution))}else{None}
    }
    pub(crate) fn edge_contributions(&self,features:&EdgeFeatures)->[f64;6] {
        self.edge_contributions_scoped(features,true)
    }
    pub(crate) fn edge_contributions_scoped(&self,features:&EdgeFeatures,include_conversion:bool)->[f64;6] {
        let values=[features.outgoing_after_cancel,features.cancelled_rows,features.conversion_units,
            features.tank_rows,features.soft_drops,features.wasted_t];
        let mut contributions=[0.;6];
        for index in 0..6 {contributions[index]=values[index]*self.edge[index];}
        if !include_conversion {contributions[2]=0.;}
        contributions
    }
    pub fn leaf(&self,features:&LeafFeatures)->Result<f64,Error> {
        let compatible=match (&features.geometry,&self.geometry) {
            (Geometry::V1(_),GeometryWeights::V1(_))=>true,
            (Geometry::V2(_),GeometryWeights::V2(_)) if self.structural_board==Some(StructuralBoardSource::Base)=>true,
            (Geometry::V2Preview(_),GeometryWeights::V2(_)) if self.structural_board==Some(StructuralBoardSource::CommittedPreview)=>true,
            (Geometry::V3(_),GeometryWeights::V3(_)) if self.structural_board==Some(StructuralBoardSource::CommittedPreviewWell)=>true,
            _=>false,
        };
        if !compatible {return Err(Error::InvalidInput);}
        let mut sum=0.;for (f,w) in features.geometry.values().iter().zip(self.geometry.values()) {sum+=f*w;}
        sum+=self.state[0]*features.b2b;sum+=self.state[1]*features.remaining_rows;sum+=self.state[2]*features.negative_margin;
        finite(sum)
    }
    pub fn edge(&self,features:&EdgeFeatures)->Result<f64,Error> {
        self.edge_scoped(features,true)
    }
    pub(crate) fn edge_scoped(&self,features:&EdgeFeatures,include_conversion:bool)->Result<f64,Error> {
        let mut sum=0.;
        for contribution in self.edge_contributions_scoped(features,include_conversion) {sum+=contribution;}
        if let Some((_, contribution))=self.normal_clear_detail(features) {sum+=contribution;}
        finite(sum)
    }
}
fn finite(n:f64)->Result<f64,Error> {if n.is_finite(){Ok(n)}else{Err(Error::NumericOverflow)}}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Geometry { V1([f64;9]), V2([f64;13]), V2Preview([f64;13]), V3([f64;14]) }
impl Geometry {
    fn values(&self)->&[f64] {match self {Self::V1(v)=>v,Self::V2(v)=>v,Self::V2Preview(v)=>v,Self::V3(v)=>v}}
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all="camelCase")]
pub struct LeafFeatures {
    pub geometry:Geometry,
    pub b2b:f64,
    pub remaining_rows:f64,
    pub negative_margin:f64,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all="camelCase")]
pub struct EdgeFeatures {
    pub outgoing_after_cancel:f64, pub cancelled_rows:f64, pub conversion_units:f64,
    pub tank_rows:f64, pub soft_drops:f64, pub wasted_t:f64,
    pub conversion_branch:&'static str, pub setup_witnessed:bool,
    #[serde(skip)] pub clear_lines:u32, #[serde(skip)] pub canonical_spin:CanonicalSpin, #[serde(skip)] pub perfect_clear:bool,
}

pub fn leaf_features(context:&Context,state:State,policy:&Policy)->Result<LeafFeatures,Error> {
    let metrics=crate::f14_compat::metrics_from_occupancy(&state.board);
    let mut geometry=[0.;9];
    geometry[..4].copy_from_slice(&[metrics.aggregate_height,metrics.max_height,metrics.holes,metrics.bumpiness]);
    let next=context.known_queue().get(state.known_cursor as usize..).ok_or(Error::InvalidInput)?;
    let t_count=state.current.into_iter().chain(state.hold).chain(next.iter().copied()).filter(|p|*p==Piece::T).count().min(2);
    let mut preview=state.board;
    let mut committed_preview=state.board;
    for _ in 0..t_count {
        let Some(location)=crate::bot::well_known_tslot_left(&preview).or_else(||crate::bot::well_known_tslot_right(&preview)) else {break;};
        preview.place(location);let clear=preview.line_clears();let lines=clear.count_ones() as usize;
        if lines>4 {return Err(Error::InvalidInput);}
        geometry[4+lines]+=1.;
        // The preview is a board-only projection. It does not consume pieces or
        // mutate canonical state; only 2-4 line clears commit the preview board.
        if lines>1 {preview.remove_lines(clear);committed_preview=preview;}else{break;}
    }
    let geometry=match policy.structural_board {
        None=>Geometry::V1(geometry),
        Some(source)=>{
            let structural_board=match source {
                StructuralBoardSource::Base=>state.board,
                StructuralBoardSource::CommittedPreview|StructuralBoardSource::CommittedPreviewWell=>committed_preview,
            };
            let structural_metrics=match source {
                StructuralBoardSource::Base=>metrics,
                StructuralBoardSource::CommittedPreview|StructuralBoardSource::CommittedPreviewWell=>crate::f14_compat::metrics_from_occupancy(&structural_board),
            };
            let mut extended=[0.;13];extended[..9].copy_from_slice(&geometry);
            extended[1]=structural_metrics.max_height;
            extended[2]=structural_metrics.holes;
            extended[9]=crate::bot::cell_coveredness(&structural_board,10).into();
            extended[10]=crate::bot::row_transitions(&structural_board).into();
            extended[11]=(structural_metrics.max_height-10.).max(0.);
            extended[12]=(structural_metrics.max_height-15.).max(0.);
            if source==StructuralBoardSource::CommittedPreviewWell {
                let mut with_well=[0.;14];with_well[..13].copy_from_slice(&extended);
                with_well[13]=crate::bot::tetris_well_depth(&structural_board).into();
                Geometry::V3(with_well)
            } else if source==StructuralBoardSource::CommittedPreview {
                Geometry::V2Preview(extended)
            } else {
                Geometry::V2(extended)
            }
        }
    };
    Ok(LeafFeatures {geometry,b2b:state.chain.b2b.into(),remaining_rows:state.incoming.pending_rows.into(),
        negative_margin:state.pressure().lock_margin.min(0) as f64})
}

fn tsd_witness(state:State)->bool {
    if state.current.is_none()
        ||!(state.current==Some(Piece::T)||(state.hold_available&&state.hold==Some(Piece::T))) {return false;}
    crate::movegen::find_native_s2_moves(&state.board,Piece::T,crate::movegen::RootEntry::Normal)
        .into_iter().take(64).any(|w| {
            let mut board:Board=state.board;board.place(w.location);
            w.spin==CanonicalSpin::Normal&&board.line_clears().count_ones()==2
        })
}

pub fn edge_features(context:&Context,before:State,action:Action,t:&Transition)->Result<EdgeFeatures,Error> {
    let (_,no_ren)=native_s2::attack(Chain {combo:0,..before.chain},t.clear,context.multiplier())?;
    let (_,withheld)=native_s2::attack(Chain {b2b:0,..before.chain},t.clear,context.multiplier())?;
    let actual=f64::from(t.attack.outgoing_before_cancel);
    let setup=matches!(t.clear.spin,CanonicalSpin::Mini)&&t.clear.lines>=1
        ||t.clear.spin==CanonicalSpin::Normal&&t.clear.lines==1;
    let setup_witnessed=setup&&tsd_witness(t.next);
    let spin=match t.clear.spin {CanonicalSpin::None=>"none",CanonicalSpin::Mini=>"mini",CanonicalSpin::Normal=>"normal"};
    let surge=t.attack.surge_chunks.iter().try_fold(0u32,|sum,n|sum.checked_add(*n)).ok_or(Error::NumericOverflow)?;
    let conversion=crate::f14_compat::classify_conversion(before.chain.combo,t.next.chain.combo,
        before.chain.b2b,t.next.chain.b2b,t.clear.lines,spin,t.amounts.cancelled_rows.into(),
        actual-f64::from(no_ren.outgoing_before_cancel),setup_witnessed,surge,actual-f64::from(withheld.outgoing_before_cancel)).ok_or(Error::InvalidInput)?;
    Ok(EdgeFeatures {outgoing_after_cancel:t.amounts.outgoing_after_cancel.into(),cancelled_rows:t.amounts.cancelled_rows.into(),
        conversion_units:conversion.units,tank_rows:t.amounts.tank_rows.into(),soft_drops:action.soft_drops().into(),
        wasted_t:u32::from(action.location().piece==Piece::T&&(t.clear.lines<2||t.clear.spin!=CanonicalSpin::Normal)).into(),
        conversion_branch:conversion.branch.as_str(),setup_witnessed,clear_lines:t.clear.lines,
        canonical_spin:t.clear.spin,perfect_clear:t.clear.perfect_clear})
}

/// Reuse the canonical finite/loss arithmetic. A failed addition propagates as
/// an error before any strategic ordering and cannot become a valid snapshot.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Value { Canonical(native_s2::Value), NumericError }
impl Value {
    pub fn finite(n:f64)->Result<Self,Error> {native_s2::Value::finite(n).map(Self::Canonical)}
    pub fn diagnostic(self)->Result<serde_json::Value,Error> {match self {Self::Canonical(v)=>Ok(v.diagnostic()),Self::NumericError=>Err(Error::NumericOverflow)}}
}
impl Default for Value {fn default()->Self {Self::Canonical(native_s2::Value::LOSS)}}
impl std::ops::Add<f64> for Value {
    type Output=Self;
    fn add(self,reward:f64)->Self {match self {Self::Canonical(v)=>v.add_reward(reward).map_or(Self::NumericError,Self::Canonical),Self::NumericError=>Self::NumericError}}
}
impl crate::dag::Evaluation for Value {
    type Reward=f64;
    type Domain=crate::dag::domain::S2Domain;
    fn average(mut of:impl Iterator<Item=Option<Self>>)->Self {
        let first=of.next().flatten().unwrap_or_default();
        if of.next().is_some() {Self::NumericError}else{first} // chance is not admitted yet
    }
    fn value(self)->f32 {panic!("S2 values must use the precise typed snapshot")}
    fn is_error(self)->bool {self==Self::NumericError}
    fn is_loss(self)->bool {self==Self::Canonical(native_s2::Value::LOSS)}
}

#[cfg(test)]
pub(crate) fn prototype()->PolicyInput {serde_json::from_str(include_str!("s2_policy-prototype.json")).unwrap()}

#[cfg(test)]
mod tests {
    use super::*;
    fn structure_policy()->PolicyInput {serde_json::from_str(include_str!("s2_policy-cc2-structure.json")).unwrap()}
    fn structure_preview_policy()->PolicyInput {serde_json::from_str(include_str!("s2_policy-cc2-structure-preview.json")).unwrap()}
    fn committed_well_policy()->PolicyInput {serde_json::from_str(include_str!("s2_policy-cc2-inheritance-well.json")).unwrap()}
    fn features_with_pieces(board:Board,current:Option<Piece>,hold:Option<Piece>,known_next:Vec<Piece>,policy:&Policy)->LeafFeatures {
        let root=native_s2::State {board,materialized_g:Default::default(),current,hold,hold_available:true,known_next,
            chain:Chain{combo:0,b2b:0},incoming:native_s2::Incoming{pending_rows:0,due_this_lock_rows:0},horizon:native_s2::Horizon::Open};
        let amounts=crate::s2_core::modelled_amounts(root.chain,root.incoming,1.).unwrap();
        let context=Context::new(root,1.,2,amounts).unwrap();
        leaf_features(&context,context.root(),policy).unwrap()
    }
    fn features(board:Board,policy:&Policy)->LeafFeatures {
        features_with_pieces(board,Some(Piece::O),None,vec![Piece::O],policy)
    }
    fn cutout(base:u32)->Board {
        let mut board=Board::default();
        for x in 0..10 {
            if x!=4 {board.cols[x]|=1<<base;}
            if !(3..=5).contains(&x) {board.cols[x]|=1<<(base+1);}
        }
        board.cols[5]|=1<<(base+2);
        board
    }
    fn committed_well_activation_board()->Board {
        Board { cols:[7,7,7,3,0,11,7,7,7,7] }
    }
    #[test]
    fn structure_distinguishes_buried_holes_and_horizontal_cavities_hidden_by_v1() {
        let old=Policy::new(&prototype()).unwrap();let new=Policy::new(&structure_policy()).unwrap();
        let mut a=Board::default();a.cols[4]=0b10101;
        let mut b=a;b.cols[4]=0b11001;
        assert_eq!(features(a,&old),features(b,&old));
        let fa=features(a,&new);let fb=features(b,&new);
        assert_eq!(fa.geometry.values()[9],6.);assert_eq!(fb.geometry.values()[9],7.);
        assert!(new.leaf(&fa).unwrap()>new.leaf(&fb).unwrap());
        a.cols[5]=0b10101;a.cols[6]=0b11001;
        b=a;b.cols.swap(5,6);
        assert_eq!(features(a,&old),features(b,&old));
        let fa=features(a,&new);let fb=features(b,&new);
        assert_eq!(fa.geometry.values()[9],fb.geometry.values()[9]);
        assert_eq!(fb.geometry.values()[10]-fa.geometry.values()[10],2.);
        assert!(new.leaf(&fa).unwrap()>new.leaf(&fb).unwrap());
        assert_eq!(features(Board::default(),&new).geometry.values()[10],128.);
    }
    #[test]
    fn structure_version_shape_and_height_breakpoints_are_explicit() {
        let input=structure_policy();let p=Policy::new(&input).unwrap();
        for (version,len) in [(FEATURE_VERSION,13),(STRUCTURE_FEATURE_VERSION,9),(STRUCTURE_PREVIEW_FEATURE_VERSION,9),(COMMITTED_WELL_FEATURE_VERSION,13),("unknown",13)] {
            let mut bad=input.clone();bad.feature_version=version.into();bad.geometry.resize(len,"0".into());
            assert!(Policy::new(&bad).is_err());
        }
        for (height,expected) in [(10,[0.,0.]),(11,[1.,0.]),(15,[5.,0.]),(16,[6.,1.]),(40,[30.,25.])] {
            let mut b=Board::default();b.cols[4]=(1u64<<height)-1;
            let f=features(b,&p);assert_eq!(&f.geometry.values()[11..],&expected);
            assert_eq!(f.geometry.values()[1],height as f64);
            assert!(Policy::new(&prototype()).unwrap().leaf(&f).is_err());
            assert_eq!(serde_json::to_value(&f).unwrap()["geometry"].as_array().unwrap().len(),13);
        }
        assert_eq!(serde_json::to_value(features(Board::default(),&Policy::new(&prototype()).unwrap())).unwrap()["geometry"].as_array().unwrap().len(),9);
    }

    #[test]
    fn committed_well_v4_adds_only_index_thirteen_and_binds_coefficient_bits() {
        let input=committed_well_policy();
        assert_eq!(input.geometry.len(),14);
        assert_eq!(input.geometry[13],"0.25");
        assert_eq!(input.geometry[13].parse::<f64>().unwrap().to_bits(),0x3fd0000000000000);
        let p=Policy::new(&input).unwrap();
        assert_eq!(p.feature_version(),COMMITTED_WELL_FEATURE_VERSION);
        let base=cutout(1);
        let f=features_with_pieces(base,Some(Piece::T),None,vec![Piece::O],&p);
        assert_eq!(f.geometry.values().len(),14);
        let v3=Policy::new(&structure_preview_policy()).unwrap();
        let legacy=features_with_pieces(base,Some(Piece::T),None,vec![Piece::O],&v3);
        assert_eq!(&f.geometry.values()[..13],legacy.geometry.values());
        let location=crate::bot::well_known_tslot_left(&base).or_else(||crate::bot::well_known_tslot_right(&base)).unwrap();
        let mut preview=base;preview.place(location);let clear=preview.line_clears();assert_eq!(clear.count_ones(),2);
        preview.remove_lines(clear);
        assert_eq!(f.geometry.values()[13],crate::bot::tetris_well_depth(&preview) as f64);
        assert_eq!(p.leaf(&f).unwrap(),
            f.geometry.values().iter().zip(input.geometry.iter().map(|s|s.parse::<f64>().unwrap()))
                .map(|(feature,weight)|feature*weight).sum::<f64>()
                + p.state[0]*f.b2b+p.state[1]*f.remaining_rows+p.state[2]*f.negative_margin);
        assert!(p.leaf(&legacy).is_err());
    }

    #[test]
    fn committed_well_feature_oracle_is_nonzero_and_changes_after_preview() {
        let p=Policy::new(&committed_well_policy()).unwrap();
        let board=committed_well_activation_board();
        let base=crate::bot::tetris_well_depth(&board);
        let f=features_with_pieces(board,Some(Piece::T),None,vec![Piece::O],&p);
        assert_eq!(base,2);
        assert_eq!(f.geometry.values()[13],1.);
        assert!(f.geometry.values()[13]>0.);
        assert_ne!(f.geometry.values()[13],base as f64);
    }
    #[test]
    fn phantom_rows_change_pressure_margin_but_not_geometry_features() {
        let p=Policy::new(&prototype()).unwrap();
        let root=native_s2::State {board:Board {cols:[(1_u64<<19)-1,0,0,0,0,0,0,0,0,0]},
            materialized_g:Default::default(),current:Some(Piece::O),hold:None,hold_available:true,known_next:vec![Piece::I],
            chain:Chain{combo:0,b2b:0},incoming:native_s2::Incoming{pending_rows:0,due_this_lock_rows:0},horizon:native_s2::Horizon::Open};
        let amounts=crate::s2_core::modelled_amounts(root.chain,root.incoming,1.).unwrap();
        let context=Context::new(root,1.,2,amounts).unwrap();
        let plain=leaf_features(&context,context.root(),&p).unwrap();
        let phantom=State {phantom_rows:3,..context.root()};
        let burdened=leaf_features(&context,phantom,&p).unwrap();
        assert_eq!(plain.geometry,burdened.geometry);
        assert_eq!(plain.b2b,burdened.b2b);
        assert_eq!(plain.remaining_rows,burdened.remaining_rows);
        assert_eq!(plain.negative_margin,0.);
        assert_eq!(burdened.negative_margin,-2.);
    }
    #[test]
    fn preview_structure_uses_committed_multi_line_board_only() {
        let base=cutout(1);
        let v2=Policy::new(&structure_policy()).unwrap();
        let v3=Policy::new(&structure_preview_policy()).unwrap();
        assert_eq!(v3.feature_version(),STRUCTURE_PREVIEW_FEATURE_VERSION);

        let actual=features_with_pieces(base,Some(Piece::T),None,vec![Piece::O],&v3);
        assert_eq!(actual.geometry.values()[4+2],1.);
        assert_eq!(actual.geometry.values()[1],2.);
        assert_eq!(actual.geometry.values()[2],1.);
        assert_eq!(actual.geometry.values()[9],2.);
        assert_eq!(actual.geometry.values()[11],0.);
        assert_eq!(actual.geometry.values()[12],0.);
        assert_ne!(actual.geometry.values()[1],features(base,&v2).geometry.values()[1]);

        for (mut board,lines) in [(base,1),(base,0)] {
            if lines==1 {board.cols[9]&=!(1<<2);}
            if lines==0 {board.cols[9]&=!(1<<2);board.cols[9]&=!(1<<1);}
            let old=features_with_pieces(board,Some(Piece::T),None,vec![Piece::O],&v2);
            let new=features_with_pieces(board,Some(Piece::T),None,vec![Piece::O],&v3);
            for index in [1,2,9,10,11,12] {assert_eq!(new.geometry.values()[index],old.geometry.values()[index]);}
            assert_eq!(new.geometry.values()[4+lines],1.);
            if lines==1 {assert_eq!(new.geometry.values()[1],old.geometry.values()[1]);}
        }

        let mut two=base;let top=cutout(4);for x in 0..10 {two.cols[x]|=top.cols[x];}
        let continued=features_with_pieces(two,Some(Piece::T),Some(Piece::T),vec![Piece::O],&v3);
        assert_eq!(continued.geometry.values()[6],2.);
    }
    #[test]
    fn coefficients_are_explicit_bounded_signed_and_f64_values_remain_distinct() {
        let input=prototype();assert!(Policy::new(&input).is_ok());
        for bad in ["NaN","inf","1000001","-0.1"] {let mut i=input.clone();i.out=bad.into();assert!(Policy::new(&i).is_err());}
        let mut i=input.clone();i.pending="0.1".into();assert!(Policy::new(&i).is_err());
        let mut i=input.clone();i.exploration="0".into();assert!(Policy::new(&i).is_err());
        let mut i=input.clone();i.exploration="5e-324".into();assert!(Policy::new(&i).is_err());
        let mut json=serde_json::to_value(input).unwrap();json.as_object_mut().unwrap().remove("tank");
        assert!(serde_json::from_value::<PolicyInput>(json).is_err());
        assert!(Value::finite(1.+1e-10).unwrap()>Value::finite(1.).unwrap());
        assert_eq!(Value::finite(f64::MAX).unwrap()+f64::MAX,Value::NumericError);
        assert!(Value::NumericError.diagnostic().is_err());
        assert!(Value::finite(-1e300).unwrap()>Value::default());
    }
    #[test]
    fn conversion_scope_can_remove_only_the_conversion_edge_contribution() {
        let p=Policy::new(&prototype()).unwrap();
        let edge=EdgeFeatures {outgoing_after_cancel:0.,cancelled_rows:0.,conversion_units:1.5,
            tank_rows:0.,soft_drops:0.,wasted_t:0.,conversion_branch:"other",setup_witnessed:false,
            clear_lines:0,canonical_spin:CanonicalSpin::None,perfect_clear:false};
        assert_eq!(p.edge(&edge).unwrap(),42.);
        assert_eq!(p.edge_scoped(&edge,false).unwrap(),0.);
        assert_eq!(p.edge_contributions_scoped(&edge,false)[2],0.);
        assert_eq!(p.edge_contributions_scoped(&edge,true)[2],42.);
    }
    #[test]
    fn normal_clear_action_reward_is_explicit_f32_table_and_non_spin_non_pc_only() {
        let mut input=prototype();
        input.action_reward=Some(ActionRewardInput {schema:ACTION_REWARD_SCHEMA.into(),group:"normal-clear-v1".into(),
            table:NORMAL_CLEAR_TABLE_TOKENS.iter().map(|s|(*s).into()).collect(),scale:"1.0".into(),number_format:ACTION_REWARD_NUMBER_FORMAT.into()});
        let policy=Policy::new(&input).unwrap();assert!(policy.action_reward_enabled());
        let mut edge=EdgeFeatures {outgoing_after_cancel:0.,cancelled_rows:0.,conversion_units:0.,tank_rows:0.,soft_drops:0.,wasted_t:0.,conversion_branch:"other",setup_witnessed:false,
            clear_lines:2,canonical_spin:CanonicalSpin::None,perfect_clear:false};
        let (units,contribution)=policy.normal_clear_detail(&edge).unwrap();
        assert_eq!(units,1.600000023841858);assert_eq!(contribution,units);
        assert_eq!(policy.edge(&edge).unwrap(),contribution);
        edge.canonical_spin=CanonicalSpin::Mini;assert!(policy.normal_clear_detail(&edge).is_none());
        edge.canonical_spin=CanonicalSpin::None;edge.perfect_clear=true;assert!(policy.normal_clear_detail(&edge).is_none());
        let mut disabled=input.clone();disabled.action_reward=Some(ActionRewardInput {group:"disabled".into(),..input.action_reward.unwrap()});
        let disabled=Policy::new(&disabled).unwrap();assert!(!disabled.action_reward_enabled());
        assert_eq!(disabled.edge(&edge).unwrap(),0.);
    }
    #[test]
    fn action_reward_admission_rejects_partial_or_unknown_objects() {
        let input=prototype();assert!(input.action_reward.is_none());
        let valid=ActionRewardInput {schema:ACTION_REWARD_SCHEMA.into(),group:"normal-clear-v1".into(),
            table:NORMAL_CLEAR_TABLE_TOKENS.iter().map(|s|(*s).into()).collect(),scale:"1.0".into(),number_format:ACTION_REWARD_NUMBER_FORMAT.into()};
        for bad in [
            ActionRewardInput {group:"unknown".into(),..valid.clone()},
            ActionRewardInput {scale:"NaN".into(),..valid.clone()},
            ActionRewardInput {scale:"101".into(),..valid.clone()},
            ActionRewardInput {table:vec!["0.0".into();5],..valid.clone()},
        ] { let mut i=input.clone();i.action_reward=Some(bad);assert!(Policy::new(&i).is_err()); }
    }
    #[test]
    fn remaining_pressure_is_charged_once_at_leaf_and_tank_margin_is_not_doubled() {
        let mut input=prototype();input.geometry=vec!["0".into();9];
        input.b2b="0".into();input.pending="-1".into();input.margin="0".into();
        input.out="0".into();input.cancel="0".into();input.conversion="0".into();input.tank="0".into();input.soft="0".into();input.waste_t="0".into();
        let p=Policy::new(&input).unwrap();
        let leaf=LeafFeatures {geometry:Geometry::V1([0.;9]),b2b:0.,remaining_rows:4.,negative_margin:0.};
        let edge=EdgeFeatures {outgoing_after_cancel:0.,cancelled_rows:0.,conversion_units:0.,tank_rows:0.,soft_drops:0.,wasted_t:0.,conversion_branch:"other",setup_witnessed:false,
            clear_lines:0,canonical_spin:CanonicalSpin::None,perfect_clear:false};
        let mut value=p.leaf(&leaf).unwrap();for _ in 0..3 {value+=p.edge(&edge).unwrap();}
        assert_eq!(value,-4.);assert_ne!(value,-12.);
        input.margin="1".into();let p=Policy::new(&input).unwrap();
        let margin=crate::s2_core::PressureView::new(12,4,8).lock_margin as f64;
        assert_eq!(p.leaf(&LeafFeatures {remaining_rows:8.,negative_margin:margin,..leaf}).unwrap(),-12.);
    }
}
