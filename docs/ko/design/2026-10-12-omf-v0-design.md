# oh-my-factory (OMF) — v0 설계

- 상태: 소유자 검토용 초안
- 날짜: 2026-10-12
- 정본 언어: 영어. 이 문서는 번역본이며 내용이 다르면 영어 정본을 따른다. 영어 정본: `docs/design/2026-10-12-omf-v0-design.md`
- 출처와 읽은 범위: `docs/design/references.md`

## 0. 요약

oh-my-factory(OMF)는 코딩 에이전트를 위한 오픈소스 소프트웨어 공장(software factory)이다. Claude Code와 Codex CLI 위에서 돌며, 둘 중 어느 쪽도 대체하지 않는다.

사람은 **목표(goal)** 를 승인한다. 목표는 지향점, 측정 방법, 접근 방식으로 이루어진다. OMF는 현재 값과 목표 값의 차이를 재고, 그 차이를 작업으로 바꾼다. 작업 하나하나는 검증 라인(verification line)을 지난다. 설계 결정은 사람이 해결한다. 구현자가 보지 못하는 봉인 인수 시나리오(sealed acceptance scenario)는 다른 벤더가 쓴다. 구현자는 격리된 컨테이너에서 일한다. 믿을 수 있는 하네스(harness)가 두 번째 일회용 컨테이너에서 결과를 판정한다. 구현자는 가린 피드백(masked feedback)만 돌려받는다. 사람은 코드 한 줄 한 줄이 아니라 **결정과 증거** 를 검토한다. 병합(merge)도 사람이 하고, 목표를 달성했다는 서명도 사람이 한다.

OMF가 아닌 것은 다음과 같다.

- 새 에이전트 런타임이 아니다. 기존 CLI를 그대로 구동한다.
- 자동 병합(auto-merge)이나 자동 배포(auto-deploy) 도구가 아니다.
- 사용자의 `AGENTS.md`, `CLAUDE.md`, `.claude/`, `~/.claude`, `~/.codex` 를 고쳐 쓰는 설치기가 아니다.
- 생각을 멈추게 하는 도구가 아니다. 사람의 판단을 가장 싸고 가장 쓸모 있는 자리로 옮긴다.
- 효과가 있다는 주장이 아니다. OMF는 스스로를 측정하고 찾은 것을 보고한다(§12).

## 1. 철학과 출처

출처는 우선순위 순서로 나열한다. 출처끼리 충돌하면 높은 쪽이 이긴다. 다만 낮은 쪽이 높은 쪽이 다루지 못한 구체적 실패 양상을 짚고 있으면 예외로 한다.

1. **Will Larson, "Trying the software factory pattern"** (lethain.com, 전문 읽음). "The software factory pattern is looping on a broad goal, and then relying on the harness to drive progress towards that goal."(소프트웨어 팩토리 패턴은 넓은 목표 위에서 루프를 돌고, 그 목표를 향한 진척은 하네스에 맡기는 것이다.) 그의 `/linear-project-loop` 는 네 단계다.
   1. 프로젝트의 목표 정의를 점검한다. 목표, 측정 방법, 접근을 적은 RFC 와, 목표 대비 진척을 재는 대시보드나 쿼리가 있어야 한다. 하나라도 없으면 사용자와 함께 만든다.
   2. 지표와 이슈 상태를 본다. 새로 찾은 일은 이슈로 더하고, 움직인 이슈는 상태를 갱신한다.
   3. 막히지 않은 작업을 한다. PR 을 쓰거나 고치고, 리뷰를 요청하고, 확인 질문을 한다.
   4. 작업이 끝나면, 프로젝트 설명이 최신이면 다음 작업으로 넘어간다. 한동안 갱신되지 않았으면 1단계부터 다시 돈다.

   핵심 통찰은 이것이다. 예전에는 에이전트가 "didn't have the ability to evaluate if they were going in the right direction, or if it was missing necessary tasks. Now it does."(옳은 방향으로 가는지, 빠진 작업이 있는지 판단할 수 없었다. 이제는 할 수 있다.) Larson 은 자신이 "accidentally hoarding parts of the state for myself regarding the goals of the project"(프로젝트 목표에 관한 상태 일부를 무심코 혼자 쥐고 있었다)고 썼다. 같은 루프를 "a less frequent post-release mode"(출시 후 저빈도 모드)로 돌리면 도입률 급증이나 오류율 상승을 잡는다. 조각들은 함께 있을 때만 복리로 쌓인다. 목표 추적(Datadog MCP, Snowflake), 회사 작업의 "single source of state"(단일 상태 원천)인 Linear, 그리고 "an orchestrated harness that can perform work independently from your laptop"(노트북과 무관하게 일하는 오케스트레이션 하네스)이다. Larson 은 이 용어의 출처를 StrongDM 의 Justin McCarthy(2026년 2월)로 조심스럽게 추정한다.
2. **Anthropic, "The AI-native SDLC playbook"** (claude.com, 2026-08-21, PDF 읽음). 같은 발상을 전체 수명주기에 적용하고, 실제 Claude Code 기능에 맞춰 쓴 글이다. "A stage ends by committing an artifact with the commit initiating the next stage"(단계는 산출물 커밋으로 끝나고 그 커밋이 다음 단계를 시작한다). 순서는 `intent.md` → `spec.md` → `plan.md` → 머지된 PR → 파이프라인이고, "a breached control band in production writes the next intent.md and so the loop continues"(운영에서 관리 대역을 벗어나면 다음 intent.md 를 쓰고 루프가 이어진다). "Detection stays deterministic. Claude is invoked once a band is breached, and the tier sets what it may do."(감지는 결정론으로 한다. 대역을 벗어나야 Claude 를 부르고, 등급이 할 수 있는 일을 정한다.) 모든 플레이는 선행 지표와 후행 지표를 짝으로 둔다. OMF 는 이 플레이북을 **도구 층과 산출물 체인의 레퍼런스 구현**으로 쓴다.
3. **StrongDM, Software Factory** (factory.strongdm.ai, 전 페이지 읽음). "Seed → Validation harness → Feedback loop. Tokens are the fuel." "The loop runs until the holdout scenarios pass (and stay passing)."(루프는 holdout 시나리오가 통과하고, 통과를 유지할 때까지 돈다.) 코드베이스 안의 테스트는 "can be lazily rewritten to match the code"(코드에 맞게 대충 고쳐질 수 있다). 그래서 시나리오는 "an end-to-end 'user story', often stored outside the codebase (similar to a 'holdout' set in model training)"이다. 만족도(satisfaction)는 "of all the observed trajectories through all the scenarios, what fraction of them likely satisfy the user?"(모든 시나리오를 지나는 관찰된 궤적 중 사용자를 만족시켰을 비율)를 묻는다. 여기서 함께 쓰는 생각은 다음과 같다.
   - 디지털 트윈 유니버스(Digital Twin Universe): "replicate behavior at the boundary"(경계에서 행동을 복제한다). 실제 의존 서비스와 대조해 "until we stop finding behavioral differences"(행동 차이가 더 나오지 않을 때까지) 검증한다.
   - 시프트 워크(shift work): 대화형 작업과 완전히 명세된 작업을 나눈다.
   - 기능 대 비기능 구분: 그럴듯한 Instagram 클론의 어려움은 "lies primarily outside the functional specification: scalability, performance, availability, security, efficiency"(주로 기능 명세 바깥, 즉 확장성·성능·가용성·보안·효율에 있다).
   - Attractor: 단계 그래프 파이프라인의 공개 명세. 커뮤니티 구현이 많다.
   - Weather Report: 어떤 모델이 어떤 역할을 맡는지 공개하는 문서.
4. **Piotr Sarnacki, "I'm sorry, but you still have to think"** (전문 읽음). "If your prompt is not specific enough, many decisions are a coin flip."(프롬프트가 충분히 구체적이지 않으면 많은 결정이 동전 던지기다.) 하위 호환, 지연 대 처리량, 부하 시 메모리, 장애 후 알림 유실이 그 예다. 지표 하나는 오해를 부른다. 그는 일정 도착률(constant arrival rate)로 부하를 걸고 전달률, 오류, 지연, 메모리를 함께 비교했다. "If you want a reliable system you should know when to fail."(신뢰할 수 있는 시스템을 원한다면 언제 실패해야 하는지 알아야 한다.)
   **Addy Osmani, "Human judgment doesn't leave the software factory. It relocates."** (전문 읽음). "Someone still chooses the problem. Someone still chooses the architecture. Someone still sets the quality bar. Someone decides which verification signals deserve trust. Someone decides when the evidence is sufficient to ship."(문제를 고르고, 아키텍처를 고르고, 품질 기준을 세우고, 어떤 검증 신호를 믿을지 정하고, 출시할 만큼 증거가 충분한지 정하는 것은 여전히 누군가의 몫이다.) 또 "Consider optimising the software factory for your reviewer."(팩토리를 리뷰어에 맞춰 최적화하라.) "Verification buys you trust, and it buys the ability to grant more autonomy to your agents."(검증은 신뢰를 사고, 에이전트에게 더 많은 자율을 줄 수 있는 능력을 산다.) 팩토리가 쓸모를 갖는 지점 중 하나는 "stopping production when human review is falling behind"(사람의 리뷰가 밀릴 때 생산을 멈추는 것)다.
5. 맥락: DHH(손으로 쓴 코드는 대부분의 프로그래머에게 더는 경제적으로 생산적이지 않다), Tunguz("Thinking in Systems, Shipping in Loops"), Dan Shapiro(다섯 단계).

**긴장을 푸는 방법.** StrongDM 의 규칙은 "Code must not be written by humans", "Code must not be reviewed by humans" 다. 검증 제약은 코드를 "validated automatically without semantic inspection of source"(소스의 의미를 들여다보지 않고 자동으로 검증)하고, "opaque weights whose correctness is inferred exclusively from externally observable behavior"(외부에서 관찰되는 행동으로만 정확성을 추론하는 불투명한 가중치)처럼 다룬다. Sarnacki 와 Osmani 는 사람의 사고를 원하고, Osmani 는 표적 리뷰가 있는 "lights-on" 팩토리를 원한다. OMF 는 한 가지 점에서 StrongDM 과 의도적으로 갈라선다. **표적 코드 리뷰를 남긴다.** 고위험 경로에서는 필수이고 그 밖에서는 선택이다. 그 밖의 부분은 사람을 없애는 대신 사람이 **무엇을** 하는지를 바꾼다.
- 작업이 시작되기 전에 목표와 측정을 승인한다(J1).
- 구현 전에 설계 결정을 해결한다(J2).
- 어떤 신호를 믿을지 고른다(J3).
- 머지할 때 증거를 판단하고(J4) 목표 달성에 서명한다(J5).

**원문을 읽고 바로잡은 점.**
- "task completion ≠ goal achievement" 라는 문장은 Larson 의 글에 없다. GeekNews 요약이 덧붙인 해석이다. OMF 는 이것을 자체 불변식(invariant)으로 선언한다(F4).
- Larson 의 루프는 다섯 단계가 아니라 네 단계다. 측정 확인은 1단계 안에 들어 있다.

## 2. 제1원칙

아래 각 메커니즘은 `tests/enforcement/` 의 강제 테스트(enforcement test)로 뒷받침되어야 한다(§13). 테스트 없는 주장에는 "not enforced"(미강제)를 붙인다.

| # | 원칙 | 출처 | 메커니즘 |
|---|---|---|---|
| F1 | 최상위 단위는 목표다. 작업은 목표에서 파생된다. | Larson; 플레이북 | `goal.md` 가 진입점이다. 모든 작업 항목은 `goal_id` 를 가진다. `goal_id` 없는 수동 시드(seed)는 허용하되 경고한다. |
| F2 | 측정 없이는 루프도 없다. 지표를 만든 쪽이 그 지표로 자기 성공을 판정해서는 안 된다. | Larson; Goodhart | `omf goal audit` 는 닫힌 채로 실패한다(fail closed). 에이전트가 제안한 지표는 J1이 승인할 때까지 `proposed` 로 남는다. 승인된 지표는 지표 금고(Metric Vault)에 해시로 잠긴다. |
| F3 | 루프는 코드가 통제한다. 모델은 해석하고 구현한다. | Larson; 플레이북 | 결정론적 상태 기계, 결정론적 감지(대역), 세션 밖에 두는 예산, 자동 연장 없음. |
| F4 | 작업 완료는 목표 달성이 아니다(OMF 불변식). | Larson 요약(GeekNews) | 에이전트는 많아야 `candidate`(후보)까지만 만든다. 목표는 사람의 서명(J5)으로만 닫힌다. |
| F5 | 출시 뒤에도 계속 지켜본다. | Larson; 플레이북 6단계 | `bands.yaml` 을 쓰는 `mode: watch`. 퇴행(regression)이 생기면 목표를 다시 연다. |
| F6 | 검증과 측정은 생성 바깥에 있다. | StrongDM | 금고(vault)는 호스트 전용이다. 즉 S4 의 하네스 컨테이너를 빼면 어떤 에이전트 세션이나 컨테이너도 읽지 못한다. 사람은 읽을 수 있다. 시나리오는 다른 벤더가 쓴다. 구현자는 시나리오, 지표 값, 임계값을 절대 보지 못한다. |
| F7 | 성공은 불확실성과 함께 보고한다. 평가하지 못한 것은 통과가 아니라 미결정이다. | StrongDM; 평가(evals) 문헌 | 결정론적 검사를 먼저 돌린다. 평가되지 않은 것은 `undetermined` 다. 독립 시나리오가 충분해지면(v0.3) 구간 추정을 쓴다. |
| F8 | 완전히 명세된 작업만 자율 실행한다. | StrongDM (시프트 워크) | 필수 결정이 하나라도 열려 있으면 실행이 막힌다. |
| F9 | 결정은 사람이 하고, 공장은 그 결정을 싸게 만든다. | Sarnacki; Osmani | 결정 인터뷰, 맨 위에 "검증되지 않은 영역" 목록을 둔 증거 보고서, 필요한 결정을 명시하는 인계 패킷(handoff packet). |
| F10 | 사람의 대역폭은 에이전트 수에 비례해 늘지 않는다. | Osmani; Larson | WIP 상한. `STOP_IF`: 검토받지 못한 증거가 쌓이면 새 생산을 멈춘다. |
| F11 | 자율성은 다이얼이고, 쌓인 증거로만 넓힌다. | Osmani; 플레이북 등급 | 자율 수준 × 위험 등급 격자. 승격에는 기록된 증거가 필요하다. |

포카요케(poka-yoke) 원칙("스킬은 위반을 드물게 만들고 훅은 거의 불가능하게 만든다", 플레이북)은 모든 규칙에 적용된다. 프롬프트와 스킬은 권고일 뿐이다. 컨테이너, 권한, 스키마, 결정론적 검사가 강제한다. 훅은 신호이지 보안 경계가 아니다.

## 3. 계층 모델

```
human judgment   J1 goal/metrics/guardrails   J2 design decisions   J3 trusted signals,
(before)                 |                         |                    high-risk paths
                         |                         |                J7 isolation/security   J8 budget
       +-----------------v---------- G  GOAL LOOP (Larson + playbook Stage 6) --------------------+
       | audit -> measure -> evaluate (gap-to-target, bands) -> reconcile -> dispatch -> refresh  |
       | mode: build (push toward target) | watch (low-frequency, after launch)                   |
       +-----------------+-------------------------------------------------------^----------------+
            down: goal_id + intent.md (no metric values,         up: outcome class, deterministic
                  thresholds or queries)                             results, open decisions
       +-----------------v---------- W  WORK VERIFICATION LOOP (StrongDM) -------+----------------+
       | S1 decide (spec.md + ledger) -> S2 seal (other vendor) -> S3 implement (plan.md, code)    |
       | -> S4 judge (two containers) -> S5 audit -> S6 masked feedback -> S7 evidence report      |
       +--------------------------------------------------------------------------------------------+
human judgment   J4 merge (gate)   J5 goal sign-off (async)   J6 stall / repeated blocker (async)
(after / async)

X  EXECUTION     L2 devcontainer (default) | L3 L2 + egress allowlist + leak red-team per run
                 L1 local sandbox exists only as "no sealing guarantee"
   SHARED STATE  host-only: ledger (hash chain), Metric Vault, Scenario Vault, run records
                 public (opt-in, in repo, committed by humans): goal.md, intent.md, spec.md, plan.md
                 tracker adapter: one source of truth per artifact
```

| 계층 | 책임 | 사람이 결정하는 것 | 사람이 결정하지 않는 것 |
|---|---|---|---|
| G 목표 루프 | 목표 감사, 측정, 격차 계산, 대역 검사, 작업 생성·갱신, 갱신 점검(refresh), 감시 | J1, J5 | 대역 안의 변동, 중복 제거, 상태 전이 |
| W 작업 검증 루프 | 결정, 봉인 시나리오, 구현, 판정, 감사, 피드백, 증거 | J2, J3, J4 | 재시도 횟수, 결정론적 결과, 이미 정한 결정을 다시 묻는 일 |
| X 실행 | 격리 수준 강제, 금고가 마운트되지 않았는지 확인, 외부 통신(egress) 통제 | J7 | 격리 검사를 통과한 뒤의 개별 권한 프롬프트 |
| 공유 상태 | 추가 전용 원장, 예산, 단일 진실 공급원, 표식 댓글(marker comment) | 어느 트래커가 진실 공급원인지 | 원장 쓰기, 멱등성 키, 정체 서명(stall signature) |

## 4. 목표 루프 (G)

### 4.1 `goal.md`

형식은 Larson의 RFC 요건(목표, 측정, 접근)을 따른다. 저장소의 선택 참여(opt-in) 디렉터리(기본값 `factory/goals/<goal_id>/goal.md`)에 두거나, 소유자가 저장소 파일을 원하지 않으면 호스트 상태에 둔다.

v0.1 은 `goal.md` 를 호스트 상태(`goals/<goal_id>/goal.md`)에 둔다. 저장소 사본은 계획 중이다.

```yaml
---
schema_version: 1
goal_id: g-<slug>
title: "..."
mode: build            # build | watch
kind: default          # default | migration
objective: "..."       # 결과를 쉬운 말로 적는다
target:                # "달성"이 무엇인지 정의한다. J1이 잠근다
  metric_id: m-<slug>
  operator: "<="       # <= | >= | ==
  value: 250
  unit: ms
leading: [m-<slug>]    # 우리 작업으로 움직이는 지표
lagging: [m-<slug>]    # 진짜 목표
link_hypothesis: "..." # 선행 지표가 왜 후행 지표를 움직여야 하는지. 반증 가능해야 한다
guardrails: [m-<slug>] # 추가 전용. 제거하려면 J1이 필요하다
prereg:                # 사전 등록. 목표와 함께 잠긴다
  min_observation: 7d
  decision_rule: "target met for 2 consecutive measurements and no guardrail breach"
  metrics_judged: 1
budget:                # 필수. 기본 연장 없음
  rounds: 10
  wall_time: 72h
  max_open_work_items: 2
state_source: markdown # markdown | github | linear | jira  (정확히 하나)
---
## Approach
...
```

J1이 승인하면 의미 필드(semantic field)를 정규화(canonicalize)하고 해시해서 지표 금고에 넣는다. 대상은 `target`, `leading`, `lagging`, `link_hypothesis`, `guardrails`, `prereg`, `mode`, `budget` 이다. 저장소의 복사본은 편의용 사본으로 본다. 그 해시가 잠긴 해시와 다르면 OMF는 **체제 변경(regime change)** 을 기록한다. 체제 변경은 J1이 다시 승인할 때까지 `candidate` 를 막는다.

`kind: migration` 은 Larson 의 "Migrations" 글(2018)의 절차를 더한다. 순서는 위험 줄이기(derisk), 도구 갖추기(enable), 마무리(finish)다. 먼저 "stop the bleeding"(출혈을 멈춘다). 새로 쓰는 코드는 모두 새 방식을 쓰게 하는 것으로, 예를 들면 린터 래칫(ratchet)이다. 다음으로 "build tooling to programmatically migrate the easy ninety-percent"(쉬운 90%를 프로그램으로 옮기는 도구를 만든다). 도구는 "incremental and reversible"(점진적이고 되돌릴 수 있게) 만든다. 긴 꼬리(long tail)는 이전을 이끄는 팀이 직접 마무리한다. "끝"은 측정된 잔여량이 0인 상태다.

### 4.2 지표 금고와 `metrics.lock`

```json
{
  "schema_version": 1,
  "metric_id": "m-p95-latency",
  "command": "<argv run inside the measure container>",
  "query": null,
  "unit": "ms",
  "owner": "human:<id>",
  "approved_by": "human:<id>",
  "approved_at": "<RFC3339>",
  "sha256": "<hash of command+query+inputs>",
  "watched_paths": ["src/telemetry/**", "..."],
  "regime": 1
}
```

- 측정은 네트워크가 제한된 일회용 컨테이너에서 **읽기 전용 자격증명** 으로 돈다. "읽기 전용"은 명령을 믿어서가 아니라 자격증명의 범위로 강제한다. 외부 시스템의 데이터는 호스트가 읽기 전용 자격증명으로 가져와 주입한다.
- `watched_paths` 는 가능하면 기계적으로 도출한다. 질의가 참조하는 이벤트 이름, 로그 문자열, 컬럼을 소스 경로로 풀어낸다. 사람이 경로를 더할 수 있다(J3). 감시 경로를 건드리는 PR은 자동으로 고위험(§6)이 되며 J4에서 diff 검토를 거쳐야 한다.
- 지표 출력은 신뢰할 수 없는 데이터다. 절대 지시로 해석하지 않는다.
- 에이전트가 지표 초안을 쓸 수 있다(Larson의 "사용자와 함께 만든다"). 초안은 시나리오와 같은 분리 원칙을 따른다. 다른 벤더가 일회성 세션에서 쓴다. J1이 승인하기 전까지는 `proposed` 로 남는다. 승인을 싸게 하려고 J1에게 지표의 이력, 민감도 검사(어떤 변경이 이 지표를 움직이는가), 음성 대조(의도적으로 나쁜 변경이 지표를 나쁘게 만들어야 한다)를 보여 준다.

### 4.3 트리거와 `bands.yaml`

목표 루프는 세 가지 이유로 깨어난다.

1. **목표 대비 격차** (Larson, build 모드): 잠긴 목표가 아직 달성되지 않았다.
2. **대역 이탈(band breach)** (플레이북 6단계, watch 모드): 이동 기준선(rolling baseline)에 대한 결정론적 감지기가 발동한다. OMF는 플레이북의 `bands.yaml` 형식을 그대로 쓴다.

   ```yaml
   metric: ci_test_failure_rate
   baseline: rolling_30d
   rules: western_electric
   tiers:
     1sigma: { action: log }
     2sigma: { action: diagnose, tools: "Read,Grep,Bash(gh run view *)" }
     3sigma: { action: propose, routes: [pull_request, runbook:rollback-deploy] }
   ```

   감지는 버전이 매겨지고 단위 테스트가 있는 스크립트이며 모델이 끼지 않는다. `diagnose` 는 읽기 전용으로 돈다. `propose` 는 W와 병합 게이트를 거치는 작업을 열거나, 미리 승인된 런북(runbook)을 발동하는 일만 할 수 있다.
3. **이벤트**: 티켓, 채널 메시지, 일정. 각각 `intent.md` 초안을 만들고, 그 초안은 같은 큐에 들어간다.

격차나 이탈이 있어야만 작업 항목을 만들 수 있다. 대역 안에 있다고 해서 목표 대비 격차가 면제되지 않는다. 목표에 도달했다고 해서 이탈이 면제되지도 않는다.

### 4.4 `omf goal tick`

틱(tick) 한 번은 Larson 루프의 한 바퀴다. 틱은 비대화형이고 호스트 상태 말고는 상태가 없다. 그래서 스케줄러, CI, 사람 누구든 실행할 수 있다.

1. **audit**: 목표 해시, 지표 잠금, 원장 해시 체인, 예산, 선행 조건을 확인한다. 하나라도 실패하면 틱을 멈추고 기록한다. 선행 조건이 없으면 인터뷰(J1)로 넘어간다.
2. **measure**: 잠긴 측정을 돌리고 값, 입력 해시, 잠금 해시를 기록한다.
3. **evaluate**: 목표 대비 격차를 계산한 뒤 대역을 계산한다. `log` 이탈은 기록만 한다.
4. **reconcile**: 모델이 작업을 제안한다.
   - 입력: 격차 요약(방향과 크기), 열려 있는 작업 항목, 최근 결과 집계, 목표의 접근 방식 본문.
   - 출력: 플레이북 1단계 형식의 `intent.md` 후보. 각 후보에 근거 필드를 둔다.
   - 이어서 결정론적 필터를 적용한다. 지문(fingerprint) 중복 제거, WIP 상한, 시드 린트(seed lint, §4.6), 기계적 위험 등급(§6)이다.
5. **dispatch**: 승인된 목표 범위와 WIP 상한 안에 있는 후보는 자동으로 시작한다. 사람은 격차 보고서에서 비동기로 거부권(veto)을 가진다. 고위험 후보는 항목별 승인을 기다린다. 시작된 항목은 호스트 상태에 선점 잠금(claim lock)을 잡는다. 그래서 `omf` 프로세스 두 개가 같은 항목을 동시에 맡지 못한다(Osmani: "avoiding different sessions from claiming the same issue").
6. **refresh**: 결정론적 신호로 `goal.md` 가 낡았는지 판단한다. 마지막 승인 이후 시간, 그 뒤에 병합된 PR, 지표의 움직임이다. 모델은 이 판단을 하지 않는다. 낡았으면 다음 틱은 J1 재인터뷰로 시작한다.

종료 상태는 `finish`, `blocked_on_user`, `failed`, `cancelled` 로 고정한다. 진행은 작업 id, 갱신 시각, 지표 값으로 만든 서명(signature)으로 추적한다. 서명이 바뀌지 않았으면 재시도하지 않고 J6으로 올린다. 같은 막힘(blocker) 서명이 세 번 나타나도 J6으로 올린다. 예산은 호스트 원장에 누적된다. 재시작해도 초기화되지 않으며 자동으로 연장되지 않는다(J8).

루프 가드는 기본으로 켜져 있다. Kilroy(MIT)의 아이디어를 가져와 그 빈틈을 막는다. Kilroy 코드는 복사하지 않았다. 선점 잠금의 낡음 판정과 서명 정규화는 Kilroy 의 설계를 따른 것이다([third-party.md](../../third-party.md), `THIRD_PARTY_NOTICES.md` 참조).

- **실패 서명 차단기(failure-signature breaker).** 서명은 `공정 | 결과 분류 | 정규화한 사유` 다. 실패일 때만이 아니라 모든 결과에 대해 센다. 실패하지 않는 루프가 차단기를 우회하면 안 된다. Kilroy 는 이 빈틈을 자기 스킬 문서에 스스로 적어 두었다. 성공해도 횟수를 초기화하지 않는다. 세 번 걸리면 J6 으로 올린다.
- **방문 상한(visit cap).** W 의 각 공정에는 작업 항목별 방문 상한이 있고, 작업 항목 전체에는 공정 실행 총 상한이 있다. 기본값은 회전당 공정별 3회 방문, 총 `max(10, 20 × rounds)` 회 실행이다. Arc 의 `maxNodeExecutions` 와 같은 모양이다. 게이트 재진입도 방문으로 센다. Kilroy 의 기본값 0(꺼짐)은 따르지 않는다.
- **선점 잠금(claim lock).** 작업 항목 단위로 `O_EXCL` 로 만든다. PID 와 프로세스 시작 시각을 기록해서, PID 가 재사용된 오래된 잠금을 가려낸다. 낡음 판정과 소유 확인은 Kilroy 의 `run_ownership_lock` 설계(같은 판정 구조)를 따랐고, TypeScript 코드는 독립 구현이다. 단일 호스트를 전제하며, 팀 모드는 범위 밖이다(§14).

M2b 에서 이 절의 모호한 점을 정리했다. 라운드의 정의, 성공 후보를 기계적으로 판정하는 방법, 틱이 쓰는 이벤트, 목표를 멈추고 재개할 수 있는 사람이 그것이다. 기록은 [M2b 부록](../../design/2026-10-12-omf-m2b-addendum.md)(영어)에 있고, 만들어진 루프가 어떻게 동작하는지는 그쪽이 기준이다.

### 4.5 성공 선언

에이전트는 `candidate` 까지만 만들 수 있다. 후보가 되려면 다음을 모두 만족해야 한다.

- 사전 등록한 결정 규칙을 충족한다.
- 모든 가드레일을 평가했고 통과했다. 평가되지 않은 가드레일이 있으면 결과는 `undetermined` 다.
- 관찰 기간에 체제 변경이 없었고 모든 잠금 해시가 일치한다.
- 최소 관찰 기간이 지났다.

증거에는 귀인 등급(attribution grade)을 적는다. 실험, 준실험, 전후 비교 중 하나다. 전후 비교는 "correlational"(상관관계)로 표시한다. 목표는 J5로만 닫힌다. 서명 뒤에는 watch 모드가 최소 관찰 기간이 지난 시점에 다시 측정하고, 퇴행했으면 목표를 다시 연다. 신기함 효과(novelty effect)를 막기 위해서다.

### 4.6 계층 간 부정행위 방지

| 경로 | 차단 | 강제 테스트 |
|---|---|---|
| 지표 코드 변조 | `watched_paths`; 변경은 체제 변경으로 표시되고 J4의 diff 검토를 강제한다 | `E1 metric-tamper-stops` |
| 에이전트가 자기 지표를 만들고 스스로 판정 | 별도 작성 세션, 이어서 J1 승인, 이어서 해시 잠금 | `E1` (승인되지 않은 지표 → 후보 없음) |
| 지표 값이 작업 쪽으로 새는 것 | 작업 항목 스키마는 값, 임계값, 질의 필드를 거부한다. 시드 린트는 숫자 임계값과 지표 이름을 거부한다. 격차 보고서는 호스트 상태에만 쓴다. | `E2 canary-no-leak` |
| 재시드(re-seeding)를 한도 없는 피드백 채널로 쓰는 것 | G의 재시드는 S6과 같은 공개 예산(disclosure budget)에서 차감된다 | `E3 budget-no-reset` |
| 시나리오 본문이 G에 닿는 것 | G는 집계만 받는다 | `E2` |
| 재시작으로 예산 초기화 | 호스트 원장 누적, 해시 체인. 원장을 잘라내는 것은 잡아내지 못한다(§8). | `E3` |
| 관측 도구에 쓰기 도구 노출 | Measure 어댑터는 읽기 전용 연산만 노출한다. 자격증명도 읽기 전용이다 | 적합성 시험 모음(conformance suite) |

알려진 한계가 있다. 카나리(canary)는 문자 그대로의 유출은 잡지만 말을 바꿔 쓴 유출은 못 잡는다. 선언되지 않은 계측 경로는 구멍으로 남는다. 네트워크를 꺼도 데이터는 모델 API 경로로 나갈 수 있다. 사람이 승인한 나쁜 지표는 여전히 나쁘며, 잠금은 그것을 안정시킬 뿐이다.

## 5. 작업 검증 루프 (W)

### 5.0 게이트

모든 게이트는 닫힌 쪽으로 실패한다(fail closed). **비어 있으면 실패다.** 시나리오 0개, 빠진 필수 게이트, 없는 판정 파일이나 결과 파일, 한 번도 방문하지 않은 게이트 노드는 모두 통과하지 못한 것으로 본다. Kilroy 의 `checkGoalGates` 는 존재하는 결과만 순회하기 때문에, 결과가 없는 goal-gate 노드가 통과해 버린다. 이것이 반면교사다. Arc 는 결과가 없으면 미충족으로 보고, OMF 는 이쪽을 따른다.

| 게이트 | 위치 | 통과 조건 | 아니면 |
|---|---|---|---|
| GATE-1 결정 | S2 전 | 필수 결정 class 에 미결이 없고, `interface` 계약이 있고, 모든 유예가 사람 서명을 받았다 | `blocked_on_user` (J2) |
| GATE-2 시나리오 유효성 | S3 전 | §5.3 | S2 로 되돌림, 또는 J3 |
| GATE-3 무결성 | S4, S5 | canary 적중 없음, 판정 설정 변경 없음, 통과한 모순 카나리 없음, 게이트 줄이 `MISCONFIGURED` 가 아님, 실측한 격리 수준이 선언한 수준 이상 | 라인 정지 (J6 또는 J7) |
| GATE-4 한도 | S6 뒤 | 회전 수, 방문 상한, 예산, 정체 서명이 한도 안에 있다 | `paused`, 그다음 J6 또는 J8 |

### 5.1 산출물 사슬

공개 사슬은 플레이북을 따른다. 이 파일들은 저장소의 선택 참여 디렉터리에 있고, 사람이 PR로 커밋한다. OMF는 이 파일을 사용자의 브랜치에 절대 커밋하지 않는다.

| 산출물 | 생산자 | 내용 |
|---|---|---|
| `intent.md` | G reconcile, 이벤트, 또는 사람 | 플레이북 1단계 형식: Problem, Proposed outcome, Affected users and systems, Constraints, Open questions, 그리고 `goal_id` |
| `spec.md` | S1 | 요구사항과 해결된 결정. 결정 원장(decision ledger)의 투영(projection)이다. |
| `plan.md` | S3 (계획 먼저) | 구현 계획. 구현이 계획에서 벗어나면 같은 커밋에서 갱신한다. |
| 후보 브랜치 `omf/<work-id>` | S3 | 코드와 구현자 자신의 테스트. OMF 소유 워크트리에 둔다 |
| `evidence.md` 와 `evidence.json` | S7 | §5.8 |

봉인 사슬은 호스트 전용이다. 결정 원장 이벤트, 시나리오, 판정(verdict), 실행 기록(run record)이 여기에 속한다.

### 5.2 S1 decide: 결정 원장

각 항목은 추가 전용 JSONL 로그의 이벤트 하나다. `spec.md` 는 이 로그에서 렌더링한다.

```yaml
id: NFR-queue-1
class: interface | compatibility | latency | throughput | memory | durability
     | queue_bound | data_model | error_semantics | security | other
question: "..."
qas: { source, stimulus, environment, artifact, response }  # SEI 품질 속성 시나리오
response_measure: { metric, op, threshold, unit, percentile, window }
status: open | resolved | deferred | na
resolution: { choice, rationale, rejected: [], by: "human:<id>", at }
deferral: { owner, reason, revisit_trigger, default, signed_by: "human:<id>", expires_at }
```

- `interface` 는 필수다. 빌드와 실행 명령, 블랙박스 종류(v0.1에서는 `cli` 또는 `http`), 입출력 계약을 담는다. 이것이 없으면 코드가 생기기 전에 시나리오를 쓸 수 없다.
- 정량적인 class의 `resolved` 항목에는 숫자로 된 `response_measure` 가 필요하다.
- `deferred` 항목에는 사람이 서명한 기본값이 필요하다.
- 린트는 결정론적이다. 필수 필드가 있는지, 임계값이 숫자인지, 열려 있는 필수 class가 없는지, 해결된 결정마다 시나리오가 하나 이상 연결되어 있는지 본다. 시나리오 연결은 호스트 쪽에서 검사하고, 원장에는 불투명한 참조(opaque reference)만 저장한다.
- **분기 탐침(Divergence probe)** (v0.2, v0.1에서는 선택): 같은 intent에서 값싼 독립 계획 세 개를 만든다. 계획 사이의 동작 차이가 아무도 말하지 않은 결정을 드러낸다. 차이마다 `open` 질문이 하나씩 생긴다. 이 장치는 열어 둔 채 방치된 결정이 아니라 애초에 적히지 않은 결정을 다룬다.

필수 결정이 열려 있는 동안 실행은 막힌다(F8, J2).

### 5.3 S2 seal

- 작성자는 구현하지 않는 쪽 벤더다(기본값: Codex). `codex exec --ephemeral` 로, OMF 소유의 `CODEX_HOME` 에서 실행한다. 대화형 세션은 기록이 남기 때문에 대화형 세션에서의 봉인은 거부한다.
- 입력은 `intent.md`, `spec.md`, 인터페이스 계약이다. 계획과 코드는 입력이 아니다.
- 출력은 시나리오 금고(Scenario Vault)로만 간다.

```yaml
schema_version: 1
scenario_id: <opaque random id>
work_id: w-<id>
author: { vendor: codex, model: "<id>", at: "<RFC3339>" }  # 구현 시작보다 앞서야 한다
decision_refs: [NFR-queue-1]
kind: behavior | nfr | contradiction_canary
split: train | test
interface: cli | http
steps:
  - invoke: { argv: [...], stdin: "..." }      # 또는 { method, path, body }
    expect: { exit_code: 0, stdout_matches: "...", json_path: { ... } }
nfr_probe: { arrival_rate, duration, thresholds: { p95_ms, error_rate, drop_rate } }  # 선택
canary: "<per-scenario random GUID>"
exposure: { count: 0, limit: 20 }
status: active | retired | contaminated
```

**GATE-2: 시나리오 유효성.** 이 게이트는 구현이 시작되기 전에 돈다.

- 활성 시나리오가 0개면 GATE-2 실패다(Arc 의 `require_scenarios` 아이디어, 기본 켜짐).

- 널 구현(null implementation, 오류나 빈 출력을 돌려주는 인터페이스 스텁)은 모든 `behavior` 시나리오에서 실패해야 한다.
- 시나리오끼리, 그리고 시나리오와 원장 임계값이 서로 모순되어서는 안 된다.
- `contradiction_canary` 시나리오는 어떤 구현에서도 실패해야 한다. 하나라도 통과하면 판정기가 고장났거나 결과가 조작되고 있다는 뜻이다.
- 사람이 금고에서 시나리오를 표본 추출할 수 있다(J3). 사람은 금고를 볼 수 있다. 증거 보고서에는 집계만 담긴다.

### 5.4 S3 implement

- 구현자는 다른 벤더다(기본값: Claude Code). L2 devcontainer에서 헤드리스(headless)로 돈다. 입력은 `intent.md`, `spec.md`, 저장소다. 금고, 호스트 상태, 다른 벤더의 CLI와 그 자격증명은 컨테이너에 없다.
- 구현자는 계획으로 시작하고 `plan.md` 를 후보 브랜치에 커밋한다.
- 설정은 OMF가 생성한 `--settings` 와 제한한 `--setting-sources` 에서 온다. `--bare` 는 쓰지 않는다. bare 모드는 구독 OAuth를 무시하기 때문이다. 사용자 저장소의 설정은 절대 고치지 않는다.
- 무인 실행에서는 기존 테스트 파일 수정이 금지된다. 구현자가 테스트가 틀렸다고 판단하면 수정 대신 명세 충돌(spec-conflict) 요청을 올린다(J2 에게 `request_human_input`, §6.2).

### 5.5 S4 judge: 두 컨테이너 계약

이 계약은 "금고는 절대 마운트하지 않는다"와 "판정기는 시나리오를 실행해야 한다" 사이의 충돌을 푼다.

```
 [SUT container]  built from candidate sha; no vault; no persistent mounts;
       ^          network: only the private harness bridge
       |  interface calls only (argv/stdin via exec bridge, or HTTP on the bridge)
 [harness container]  scenarios + runner; read-only; disposable; no internet
       |
       v  verdict JSON (schema-validated) -> host
```

SUT(시험 대상 시스템, system under test)는 각 호출의 **입력** 만 받는다. 시나리오 파일, 기대 출력, 단언문(assertion)은 절대 받지 않는다. 두 컨테이너는 라운드가 끝날 때마다 파괴되고, 라운드 사이에 캐시를 공유하지 않는다.

검사 순서는 다음과 같다.

1. 결정론적 게이트를 fast, full, deep 순서로 돌린다(검증 예산; addyosmani/factory `gates.sh` 패턴). 결과는 기계가 읽을 수 있는 한 줄이다. 예: `OMF_GATES: fast=pass full=pass deep=skip`. 필수 게이트가 없으면 `MISCONFIGURED` 이며 절대 초록(green)이 아니다.
2. 봉인 시나리오를 k번 반복해서 불안정성(flakiness)을 잡는다. v0.1은 통과/실패와 불안정 재시도를 보고한다. 확률과 Wilson 구간은 독립 시나리오가 충분해지는 v0.3부터 쓴다. 결정론적 검사를 반복하면 일반화가 아니라 불안정성이 측정된다.
3. `prove-test` (addyosmani/factory): 테스트가 아닌 hunk를 되돌리고 구현자 자신의 테스트가 실패하는지 확인한다. 보조 증거로 돈다.
4. LLM 판정 (v0.3): 구현자와 다른 벤더의 세 번째 읽기 전용 세션이다. A/B 순서를 바꿔 두 번 채점하고, 의견이 갈리면 무승부로 기록한다.

### 5.6 결과 분류

OMF는 Osmani와 Vercel이 설명한 실행 결과 분류를 쓴다.

| 결과 | 뜻 | 다음 단계 |
|---|---|---|
| `success` | 필수 게이트 전부 통과, 봉인 시나리오 통과, 감사 플래그 없음 | 증거 보고서 → J4 |
| `flawed` | "The wrong thing was implemented or maybe it didn't have full context"(잘못된 것을 구현했거나 맥락이 부족했다, Osmani). OMF 는 겉으로 초록이지만 틀린 결과도 여기에 넣는다. `prove-test` 실패, 카나리 적중, 테스트 수정, 또는 공개 테스트는 통과하는데 봉인 테스트는 실패하는 경우다. | 가린 피드백, 반복되면 J6 |
| `blocked` | "The environment may have been missing a credential"(환경에 자격 증명이 없었을 수 있다, Osmani), 그 밖의 인프라 장애, 또는 빠진 결정 | 환경을 고친다, 또는 J2 |
| `manual` | "A boundary the factory may not be allowed to cross yet"(팩토리가 아직 넘어서는 안 되는 경계, Osmani). 신뢰의 경계이고, 사람이 행동해야 한다. | 인계 패킷(§6.3). "A manual run isn't finished when the factory stops but when the human knows what to do next."(manual 실행은 팩토리가 멈출 때가 아니라 사람이 다음에 할 일을 알 때 끝난다.) |

머지 권고를 달고 J4 에 도달하는 것은 `success` 뿐이다. Osmani 는 나머지 셋 중 둘은 "may have mechanical fixes and the last one is about trust"(기계적으로 고칠 수 있고, 마지막 하나는 신뢰의 문제)라고 쓴다. 이 분류는 항상 단계별 소요 시간과 함께 보고한다. 시간이 없으면 "you know a run came back flawed without knowing what finding out cost you"(실행이 flawed 로 돌아왔다는 것만 알고, 그걸 알아내는 데 든 비용은 모른다).

### 5.7 S6 가린 피드백

- 피드백은 `train` 분할만 쓴다. `test` 분할은 마지막에 정확히 한 번만 쓴다.
- 피드백에는 범주별 통과 비율을 담는다. 시나리오가 5개 미만인 범주는 공개 전에 더 큰 범주에 합친다.
- 공개 규칙은 래더(Ladder)를 따른다. 새 점수는 지금까지 공개된 최고 점수를 `max(0.1, 1/sqrt(n))` 이상 넘을 때만 공개한다. `n` 은 공개 대상 범주에 든 시나리오 수다. 아니면 직전에 공개한 점수를 반복한다. 공개 횟수는 목표와 시나리오 집합 단위로 센다. 그래서 작업 항목을 바꿔도 예산이 초기화되지 않는다.
- 피드백에는 시나리오 id, 입력, 기대 출력, 단언문 텍스트를 절대 담지 않는다.

### 5.8 S7 증거 보고서

`evidence.md` 는 사람용이고 `evidence.json` 은 기계용이다. 보고서 맨 위에는 **자동 검증이 다루지 못한 것** 을 나열한다. 검토자는 그곳을 봐야 한다.

```yaml
schema_version: 1
work_id; goal_id; outcome: success|flawed|blocked|manual
recommendation: merge_recommended | not_recommended | human_needed   # + 이유
unverified_areas: [...]
decisions: [{ id, threshold, measured, status }]   # 원장 대 현실
gates: "OMF_GATES: ..."
sealed: { train: {pass, total, flaky}, test: {pass, total} | "not yet run" }
audit: { canary_hits, tests_edited, prove_test, judge_config_touched }
isolation_level: L2
high_risk_paths_touched: [...]                     # 비어 있지 않으면 J4에서 diff 검토 필수
label: "pre-verified / goal impact not measured"
noise_check: "gain within run-to-run variance → not_recommended"
self_metrics: { stage_times, rounds, human_interventions_by_J, budget_used }
untrusted_fields: [plan_summary, implementer_notes]  # 구현자가 쓴 필드
```

## 6. 사람 판단 지도

| J | 시점 | 결정 | 기본값 |
|---|---|---|---|
| J1 | 이전 | 목표, 지표, 목표값, 가드레일, 사전 등록 ("문제를 고른다") | 없음 |
| J2 | 이전 | 설계 결정과 인터페이스 계약 ("아키텍처를 고른다") | 없음. 열려 있는 동안 실행이 막힌다. |
| J3 | 이전, 그리고 시나리오나 감시 경로가 바뀔 때마다 | 믿을 신호, 고위험 경로 목록, 시나리오 승격 ("품질 기준을 세운다", "어떤 신호를 믿을지 정한다") | 결정론적 검사만 믿는다. 고위험 목록은 아래 기본값에서 시작한다. |
| J4 | 게이트 | 병합 ("증거가 충분한지 정한다") | 없음. 브랜치 보호는 OMF가 설정하지 않고 `omf doctor` 가 점검한다. |
| J5 | 비동기 | 목표 서명과 재개 | 없음. 목표는 `candidate` 로 기다린다. |
| J6 | 비동기 | 정체, 반복된 막힘, 예산 소진: 계속할지, 멈출지, 다시 정의할지 | 멈춘 채로 둔다 |
| J7 | 이전 | 격리 수준, 보안 설정, 비상 우회(break-glass) | 모든 예외를 원장에 기록한다 |
| J8 | 이전 | 예산 상한과 증액 | 자동 연장 없음 |

**위험 등급은 기계적이다.** diff와 경로로 계산하며, 에이전트가 고르지 않는다. 기본 고위험 경로는 CI와 워크플로 파일, 인증, 마이그레이션, 감시(계측) 경로, 목표와 공장 파일, 잠금 파일(lockfile)이다. 테스트 파일은 선언했을 때도 변경했을 때도 그 자체로는 고위험이 아니다. 선언된 테스트 경로에는 아직 약화할 diff 가 없으므로 디스패치 시점에 항목을 고위험으로 만들지 않는다. 구현 뒤에 감사가 실제 diff 에 결정론적 테스트 약화 검사를 돌려, 변경이 테스트 파일 삭제, 지운 단언(assertion) 줄이 더한 단언 줄보다 많은 변경, skip·only·todo·fixme·예상 실패·x·f 접두 표식 추가, 다른 테스트의 실행 방식을 바꾸는 훅(어느 깊이의 `conftest.py`, Go `TestMain`·`func init()`, `this.skip()`, `os.Exit`·`sys.exit`·`process.exit`·`pytest.exit` 같은 프로세스 종료) 추가, 테스트나 커버리지 설정의 숫자 임계값 하향·삭제(한 줄의 코드 부분의 `키: 숫자` 쌍을 모두 비교하므로 주석 처리한 임계값은 삭제로 보고, 짝지을 수 없는 줄은 약화로 본다), 테스트 경로 아래 러너·커버리지 설정의 신규·수정(임계값 숫자만 올리고 바뀐 줄의 나머지가 그대로인 경우는 제외하며, 시험 경로 아래의 `.coveragerc`·`codecov.yml`·`package.json` 도 같은 기준이다), 테스트 경로나 커버리지·러너 설정의 바이너리 구역(NUL 한 바이트만 있어도 구역이 바이너리가 되며, 읽을 수 없으므로 약화로 본다) 중 하나라도 하면 위험 등급을 고위험으로 올린다. 시험 파일의 모드만 바뀐 변경은 정상이지만, 테스트 경로 아래 러너·커버리지 설정이나 `conftest.py` 의 모드만 바뀐 변경은 임계값만 올렸다는 근거가 없으므로 약화로 본다. 어느 깊이의 `conftest.py` 삭제, 바이너리 커버리지·러너 설정 삭제, 테스트 경로 아래 새 바이너리 파일(읽을 수 없으므로 픽스처도 보수적으로 고위험)도 약화다. 추가된 줄에서는 표식을 코드 부분에서 찾고, 닫힌 블록 주석 뒤의 코드(`/* x */ describe.only(...)`)와 주석 안의 CR, U+2028, U+2029 뒤의 코드도 함께 본다. 순수 주석 줄은 표식이 아니다. 주석 제거는 단언 개수와 삭제된 줄에서는 그대로이다. INI 형식 설정(`.coveragerc`, `setup.cfg`, `tox.ini`, `pytest.ini`)에서는 `;` 로 시작하는 줄이 주석이므로 그렇게 주석 처리한 임계값은 삭제로 본다. 줄 중간의 ` ;` 는 pytest 와 coverage.py 가 자르지 않으므로 주석이 아닙니다. 테스트 경로 밖의 러너·커버리지 설정에는 숫자 임계값 검사를 적용하며, 임계값이 있는 줄의 해석이 모호할 때도 보수적으로 처리한다. 테스트를 약화하지 않는 테스트 변경은 이제 근거에 고위험 경로 검토 영역을 더하지 않는다(예전에는 더했다). diff 본문을 볼 수 없거나 변경 경로 목록과 맞지 않아 검사를 돌릴 수 없으면 테스트 변경은 계속 고위험이다. 감사는 선언된 위험에 규칙을 더하기만 하므로 위험은 선언과 감사 사이에서 올라가기만 한다.

따옴표 안의 `#`와 `//`는 코드에 남기고, 실제 줄 끝 주석은 무시합니다. 임계값이 있는 줄에서 따옴표 밖의 슬래시가 정규식을 시작할 수 있거나 따옴표가 닫히지 않아 주석 경계가 모호하면 약화로 판정합니다. 이런 줄에는 임계값만 올렸다는 설정 예외를 적용하지 않으므로, 정상 변경도 보수적으로 표시할 수 있습니다.

줄 단위 검사의 알려진 한계: 여러 줄에 걸친 블록 주석, 시험을 건너뛰게 하는 이른 return 이나 `if (false)`, 더 약한 매처, 항상 참인 단언으로의 교체, 스냅샷·픽스처 수정, 돌릴 테스트를 좁히는 include·exclude 는 따라가지 못한다. 바이너리 구역이 무엇을 바꾸는지는 검사하지 않고 읽을 수 없는 구역으로 표시할 뿐이다. 지운 단언 줄과 더한 단언 줄의 개수를 비교하므로 개수를 유지하는 재작성은 그대로로 보인다. 올린 허용치(codecov `threshold`, 스크린샷 임계값)는 감지하지 못한다. 표식·훅 목록은 이름의 목록이라서 별칭, 다른 종료·실행 호출, 프레임워크 몽키패칭, 코드에서 정하는 러너 플래그는 감지하지 못한다. 이 검사는 여러 방어선 중 하나다. 기존 테스트를 고치면 결함 신호(`test_edited`)가 되고, prove-test 는 올바른 이유로 실패해야 하며, 심판·게이트 파일의 수정(`judge_config_touched`)도 검사한다. 사람은 J3에서 목록을 넓힌다.

### 6.1 배압(back-pressure)

`STOP_IF`: 검토받지 못한 증거 보고서가 세 개 이상이면 새 작업을 디스패치하지 않는다. 임계값은 J8에서 설정할 수 있다. addyosmani/factory 헌장 패턴과 F10을 따른다.

### 6.2 사람에게 묻기

OMF는 12-factor-agents Factor 7의 형태를 쓴다(CC BY-SA, 출처 표시). 루프는 답을 기다리며 멈춰 서 있지 않는다. 상태를 저장하고 종료했다가 답이 오면 재개한다.

```yaml
request_human_input:
  id; j: J2; question; context; options: [...]; default: null
  urgency: low|normal|high; format: choice|text
  resume_token
```

승인(`approve`/`deny`)과 질문은 서로 다른 연산이다.

**조용한 승인은 없다.** 비교한 두 프로젝트는 모두 어떤 경로에서는 기본으로 승인한다. Kilroy 의 CLI 는 자동 승인 인터뷰어를 주입하고, 타임아웃이면 `human.default_choice` 로 가는 경로가 있다. Arc 는 TTY 가 없으면 자동 승인하고, 맞지 않는 답을 첫 선택지로 처리한다. OMF 는 이 중 어느 것도 하지 않는다. TTY 가 없으면 요청을 저장하고 종료한다. 맞지 않는 답은 다시 묻는다. 타임아웃이면 항목은 멈춘 상태로 남는다. 집행 테스트는 `E8 no-auto-approve` 다.

### 6.3 인계 패킷(handoff packet)

`manual` 결과, J6 에스컬레이션, 그 밖에 사람이 필요한 정지는 인계 패킷을 만든다. 패킷이 사람에게 다음에 할 일을 알려 줘야만 실행이 끝난 것으로 본다.

```yaml
handoff:
  schema_version: 1
  work_id; goal_id; outcome
  state: "<루프가 어디서 왜 멈췄나>"
  ran: ["<실행한 명령과 게이트, 결과>"]
  remaining: ["<끝내지 못한 일>"]
  risks: ["<알려진 위험과 검증되지 않은 영역>"]
  decision_required: { j: J2|J3|J4|J6|J7|J8, question, options: [...] }
  resume: "omf answer <request-id>"
```

## 7. 실행과 격리

| 수준 | 구현자 (S3) | 판정기 (S4)와 측정 | 증거에 붙는 라벨 |
|---|---|---|---|
| L1 | 로컬 샌드박스 (거부 규칙, 비운 환경 변수) | 일회용 컨테이너 | "no sealing guarantee" (봉인 보장 없음) |
| **L2 (기본값)** | devcontainer, 금고 마운트 없음, 구현자 벤더의 CLI와 자격증명만 | 두 컨테이너 계약 | "sealed (container)" |
| L3 | L2에 외부 통신 허용 목록(모델 API만)을 더하고, 매 실행마다 유출 레드팀 테스트 | 동일 | "sealed (container, egress-restricted)" |

**인증.**

- 로컬에서는 두 벤더 모두 구독 사용을 지원한다. 구현자 컨테이너에는 구현자 벤더의 자격증명만 들어간다.
- 위협 모델 참고: 그 컨테이너 안에서 실행되는 코드는 그 자격증명을 읽을 수 있다. L3은 유출을 줄이지만 없애지는 못한다.
- 원격과 CI에서는 API 키를 기본으로 쓴다. OMF는 구독 토큰을 저장하거나 중개하지 않는다.
- 작성 세션과 판정 세션은 OMF 소유의 설정 홈(config home)을 쓴다. OMF 호스트 상태 안에서 자격증명 파일만 0600 권한으로 복사한다.

**격리는 선언이 아니라 실측이다.** 비교한 두 프로젝트 모두 선언한 격리 설정이 실제로는 집행되지 않았다. Arc 의 `useWorktrees` 는 이 값을 읽는 코드가 없다. Kilroy 의 worktree 경계는 프롬프트의 한 문장일 뿐이고, review 명령은 원본 레포에서 권한 우회로 실행된다.

- 격리 실측 등급은 원장에서 나온다. 실행마다 단계(작성은 봉인 시점, 이어서 구현자·SUT·하니스)를 실측하고 측정 하나마다 `isolation.measured` 이벤트를 추가한다. 금고 미마운트, 자격 증명 범위, 샌드박스 값, 외부 통신 규칙이 대상이다. 권위는 원장에 있고, 호스트 전용 `isolation.json` 은 그 이벤트를 보여 주는 뷰일 뿐이다. 증거 리포트에는 이 이벤트에서 계산한 등급을 싣는다. 실측 등급이 선언 등급보다 낮으면 GATE-3 이 실패한다.
- `omf doctor` 는 사전 점검 보고서(`preflight.json`, Kilroy 의 `--preflight` 를 따름)에 격리를 참고용으로만 적는다. 선언 등급과 라벨일 뿐 집행하지 않으며 `ok` 에도 영향을 주지 않는다.
- 권한 우회 플래그는 L2·L3 컨테이너 안에서만 허용한다. 호스트나 사용자의 원본 체크아웃에서는 절대 쓰지 않는다.
- 구현자 세션은 OMF 소유의 설정 디렉터리를 받는다. 사용자의 `~/.claude` 나 `~/.codex` 를 물려받지 않는다.
- worktree 는 추적되는 파일로만 만든다. Kilroy 는 gitignore 된 파일을 전부 worktree 로 복사하는데, 여기에 비밀이 섞일 수 있다. OMF 는 그러지 않는다.

**신뢰할 수 없는 입력.** 이슈 본문, 채널 메시지, 지표 출력은 신뢰할 수 없는 데이터다. 트리거는 식별자만 전달하고, 내용은 OMF가 직접 읽는다(addyosmani/factory `factory-fire` 패턴).

## 8. 공유 상태

```
~/.omf/projects/<repo-hash>/
  ledger.jsonl          # 추가 전용, 해시 체인, omf 호스트 프로세스만 쓴다
  vault/metrics/        # metrics.lock 파일, 목표 의미 해시, 사전 등록
  vault/scenarios/      # 봉인 시나리오 (하네스 외에는 어떤 컨테이너에도 마운트하지 않는다)
  runs/<UTC>-<stage>-<id>.md   # 불변 실행 기록
  worktrees/<work-id>/  # OMF 소유 워크트리 (git 이 .git/worktrees 와 refs/heads/omf/* 에 쓴다)
  config.toml           # [roles] 포함: 역할별(작성자, 구현자, 판정자, 조정자) 모델과 effort.
                        # StrongDM Weather Report 의 정신을 따른다
```

원장 봉투(envelope):

```json
{ "schema_version": 1, "seq": 42, "prev_hash": "<sha256>", "hash": "<sha256>", "ts": "<RFC3339>",
  "actor": "omf | human:<id> | agent:<vendor>", "type": "<event type>", "payload": {} }
```

`hash` 는 `hash` 필드를 뺀 이벤트의 정규 JSON(키를 RFC 8785 와 같은 UTF-16 코드 단위 순서로 정렬, 공백 없음)에 대한 SHA-256이다. 첫 이벤트의 `prev_hash` 는 0 64개다.

모든 명령은 동작하기 전에 체인을 검증한다. 체인이 깨져 있으면 OMF는 멈춘다. v0.1의 사람 서명은 `human:<git user.email>` 에 대화형 TTY 확인을 더한 것이다. 암호학적 서명이 아니다. SSH 서명 승인은 v0.2에서 계획한다.

**잘린 쓰기.** 충돌(crash)로 마지막 줄에 줄바꿈이 빠질 수 있다. 그 줄이 완전한 이벤트면 다음 추가(append)가 줄바꿈을 붙인다. 완전하지 않으면 `omf ledger verify` 는 경고하고 0으로 끝나며, 다음 추가가 그 부분 줄을 지우고 지운 바이트 수와 SHA-256을 담은 `ledger.tail_discarded` 이벤트를 남긴다. 그 밖에 JSON 객체로 읽히지 않는 줄은 손상이다.

**한계.** 체인은 기록된 이벤트의 수정을 잡아낸다. 파일 끝에서 이벤트를 지우는 것과, 해시가 맞도록 파일 전체를 다시 쓰는 것은 잡아내지 못한다. 그래서 체인은 사고와 `~/.omf` 에 쓸 수 없는 프로세스를 막을 뿐, 쓸 수 있는 사람을 막지는 못한다. 특히 예산(E3)은 재시작에는 살아남지만 잘라낸 원장에는 살아남지 못한다. 에이전트를 호스트 상태에서 떼어 놓는 일은 격리(§7)가 맡는다. 프로젝트는 체크아웃의 주 작업 트리 실제 경로로 식별한다. 그래서 체크아웃을 옮기거나 이름을 바꾸면 상태와 예산이 새로 시작하는 새 프로젝트가 된다. OMF는 디렉터리를 0700, 파일을 0600 으로 유지하지만, `~/.omf` 안에 심어 둔 심볼릭 링크는 따라가지 않고 거부한다. 모든 진입점(프로젝트 조회, `omf init`, `omf doctor`, `omf ledger verify`, `decide` 쓰기, 라인)이 문제의 경로를 대고 멈춘다. 검사와 열기 사이에 경로를 바꿔치기하는 쓰기는 잡아내지 못한다.

**트래커.** 산출물마다 진실 공급원은 정확히 하나다. 플레이북의 레거시 공존 규칙을 따른다. 저장소가 공급원이거나, 레거시 시스템이 공급원이거나, 둘을 서로 연결한다. 어댑터 계약은 Symphony SPEC §11 을 따른다. 읽기 연산 둘이 필수다. `fetch_issues_by_states` 와 `fetch_issues_by_ids` 다. 쓰기는 선택이며 연산 하나에 동사 하나다. 범용 CRUD는 제공하지 않는다. 이슈마다 진행 상황용 표식 댓글을 하나 둔다. 지표 값은 트래커에 절대 쓰지 않고 요약과 참조만 쓴다.

## 9. CLI (v0.1)

| 명령 | 목적 |
|---|---|
| `omf init` | 호스트 상태만 만든다. 저장소에는 아무것도 쓰지 않는다. |
| `omf doctor` | CLI, Docker, 인증, 격리 수준, 브랜치 보호를 감지한다. 이 환경에서 쓸 수 있는 보장을 보고한다. |
| `omf goal new` / `audit` / `approve` | `goal.md` 생성, 인터뷰 진행, J1, 잠금 |
| `omf metric propose` | J1 에 올릴 지표(명령, 단위, 감시 경로)를 제안 |
| `omf goal measure` | §4.4 의 1~3단계만 단독 실행: 감사, 측정, 평가, 격차 보고서 |
| `omf goal tick` | G 한 바퀴 (§4.4) |
| `omf goal status` / `resume` / `cancel` | 실행 상태와 다음 단계 보기, J6 계속, J6 중지 |
| `omf work list` / `show` / `approve` | 작업 항목 조회, 고위험 항목 승인 (J 번호 없음, M2b 부록 참고) |
| `omf budget show` / `declare` / `raise` | 예산 조회, 선언, 증액(J8). `raise ... wall_time` 은 벽시계 시간을 늘린다 |
| `omf goal sign` | J5 |
| `omf decide <work-id>` (하위 명령 `add`, `resolve` (`--na`), `defer`, `lint`, `show`) | S1 인터뷰, `spec.md`, J2 |
| `omf seal <work-id>` | S2와 GATE-2 |
| `omf run <work-id>` | S3에서 S6까지의 루프. 예산으로 한정한다. |
| `omf report <work-id>` | S7 |
| `omf ship <work-id> --open-pr` | 후보 브랜치를 푸시하고 PR을 연다. 사람이 호출할 때만 실행한다. |
| `omf veto <work-id>` | 자동 디스패치된 작업 항목에 대한 비동기 거부권 |
| `omf answer <request-id>` | `request_human_input` 에 답하고 재개한다 |

## 10. 도구 계층

**패키징** 은 oh-my-* 관례를 따른다. npm 패키지 `oh-my-factory` 하나, bin `omf` 하나, Node 22 이상, TypeScript, Apache-2.0 이다.

v0.1 에서는 아래 `packages/*` 경계를 패키지 하나 안의 디렉터리(`src/core`, `src/goal`, `src/verify`, `src/adapters`, `src/cli`)로 둔다. 두 번째 사용처가 생길 때 워크스페이스 패키지로 나눈다.

```
oh-my-factory/
  packages/core         state machine, ledger (hash chain), budgets, termination states, schema validation
  packages/goal         audit, measure, evaluate (gap + bands), reconcile, dispatch, refresh, watch
  packages/verify       decide, vault, seal, judge (two containers), gates, feedback, report
  packages/adapters     state-markdown | measure-cmd | runner-devcontainer
                        (later: state-github, state-linear, measure-mcp-readonly, runner-e2b)
  packages/conformance  adapter conformance suites (third-party adapters must pass)
  packages/cli          omf
  shells/claude-code-plugin, shells/codex-skill    (v0.2: thin; they call the CLI only)
  schemas/              *.schema.json (schema_version required)
  tests/enforcement     one test per control claim
  examples/hello-goal   offline end-to-end example
  docs/                 concepts, getting started, threat model, limits; docs/ko/ Korean
```

**OMF가 따르는 참조** (새로 만들지 않고 가져온 것):

| 무엇 | 출처 (라이선스) |
|---|---|
| 산출물 사슬, 대역, 등급, 선행/후행 지표, 검증기(verifier), 스킬 대 훅 | Anthropic AI-native SDLC playbook |
| 플러그인과 스킬 배치, 헤드리스 설정 격리, 루프 가드(종료 상태 넷, 막힘 차단기, 진행 서명) | oh-my-claudecode, oh-my-codex, oh-my-openagent |
| 게이트 라인, `MISCONFIGURED`, `prove-test`, `STOP_IF`, 불변 실행 기록, 버전이 매겨진 인계, 식별자 전용 트리거 | addyosmani/factory (MIT) |
| 실행 결과 분류 | Vercel (블로그); Osmani |
| 분류(triage) 상태, 읽기 전용 판정 작업과 쓰기 작업의 분리 | warpdotdev-demos/cloud-factory-demo (MIT) |
| 트래커 어댑터 계약, 표식 댓글 | openai/symphony SPEC (Apache-2.0) |
| 측정 제공자 계약, "N회 연속 실패" 임계값 | Argo Rollouts, Flagger (Apache-2.0) |
| 사람 요청 계약, 저장 후 종료(persist-and-exit) | 12-factor-agents Factor 7 (CC BY-SA, 출처 표시) |
| devcontainer 런타임; 이후 원격 샌드박스 | devcontainer spec 과 devcontainers/cli; E2B (Apache-2.0) |
| 결정 필드; 봉인 테스트 점수 | SEI QAS; spec-kitty (MIT); shadow-score-spec (MIT) |
| train/holdout 기준 유지/되돌리기 | Anthropic "Automating eval design and hillclimbing" |
| 루프 가드(실패 서명 차단기, 방문 상한), 선점 잠금, 공정별 체크포인트와 재개, 사전 점검 보고서, parity matrix 와 CLI 사용법 드리프트 테스트 | danshapiro/kilroy (MIT, 저작권 StrongDM, Inc.; 아이디어 차용, 선점 잠금 낡음 판정과 서명 정규화는 설계를 따름, 코드 복사 없음, [third-party.md](../../third-party.md)·`THIRD_PARTY_NOTICES.md` 참조) |
| 그래프로 표현한 파이프라인(v0.2 에서 검토): 단계 노드, 사람 게이트, 체크포인트, 목표 게이트 | strongdm/attractor 명세(Apache-2.0)와 커뮤니티 구현. 특히 Kilroy(Dan Shapiro, Go, git worktree), Arc(TypeScript, holdout 시나리오, 수렴 루프), amolstrongdm 의 Attractor(holdout 과 트윈 대상 만족도 채점) |
| 역할별 모델 배정을 공개하고 버전 관리 | StrongDM Weather Report |
| 부하 탐침 | k6, 바이너리로만 호출 (AGPL, 코드 복사 없음) |

**피할 것:**
- AGPL 코드 복사 (skorokithakis/symphony, Unleash 번들).
- 보관(archived)된 Kayenta.
- 지원 중단된 HumanLayer SDK.
- 비공개로 돌아선 Daytona 코어.
- 대상 저장소를 고치는 설치기 (addyosmani/factory 설치기, Gas Town `bd init`, spec-kit).

## 11. 비오염 및 안전 규칙

이 규칙은 `tests/enforcement` 가 강제한다.

1. OMF는 사용자의 `AGENTS.md`, `CLAUDE.md`, `.claude/`, `~/.claude`, `~/.codex` 를 읽기만 한다. 셸(shell)은 `--plugin-dir` 주입을 우선한다. 마켓플레이스 설치는 선택 참여이며 "writes user scope"(사용자 범위에 쓴다)라는 라벨을 붙인다. OMF는 자기 상태를 저장소 안이나 에이전트 CLI 설정 홈(`~/.claude`, `~/.codex`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`) 안에 두지 않는다. `omf doctor` 는 에이전트 CLI를 쓰고 버리는 임시 홈에서 실행한다. 이 CLI들은 `--version` 만 실행해도 캐시를 쓰기 때문이다.
2. OMF는 사용자 브랜치에 자동 커밋하지 않고 병합도 하지 않는다. 후보는 OMF 소유 워크트리의 로컬 `omf/*` 브랜치에 둔다. 푸시와 PR 생성은 `omf ship` 으로만 일어난다.
3. 공개 산출물(`goal.md`, `intent.md`, `spec.md`, `plan.md`)은 OMF 워크트리에 쓴다. 사람이 일반 PR 흐름으로 커밋한다.
4. 봉인 자료(시나리오, 잠금, 카나리)가 저장소 안에 나타나면 포카요케 검사가 실행을 거부한다.
5. 실행할 때마다 거버넌스 파일을 다시 읽는다. 읽을 수 없으면 기본값으로 물러서지 않고 OMF가 멈춘다.
6. 비상 우회(break-glass) 예외는 원장에 사유와 만료 시각을 적은 J7 이벤트로 남긴다.

## 12. OMF 자체 측정

자체 지표는 플레이북의 선행/후행 지표와 Osmani의 "검토자에게 맞춰 최적화하라"에서 고른다.

- 단계별 소요 시간 (intent → spec → plan → candidate → evidence → merge)
- 첫 시도 `success` 비율
- 재작업 라운드
- J별 사람 개입 횟수와 J별 결정 시간
- 증거 보고서당 검토 시간
- 병합 뒤 발견된 유출 결함(escaped defect)
- 병합된 변경당 비용

**OMF의 사전 등록 중단 기준(kill criteria) (v0.1에서 v0.2까지).** 예제 프로젝트와 첫 도그푸딩(dogfood) 목표에서 평가한다.

- 병합된 변경당 사람 개입 횟수가 같은 작업을 일반 에이전트 세션으로 한 경우보다 낮지 않으면 G 계층을 재검토한다.
- 유출 결함이 일반 세션보다 많으면 기본 자율성을 낮춘다.
- GATE-2가 널 구현이 통과하는 시나리오를 통과시키면 봉인을 보장으로 내놓지 않는다.

## 13. v0.1 걸어다니는 뼈대(walking skeleton)

뼈대는 목표 루프를 두 바퀴 끝에서 끝까지 돌려 증명해야 한다.

1. `omf init` 과 `omf doctor`.
2. `omf goal new`, 이어서 J1, 이어서 잠금: 목표 지표 하나, 가드레일 하나, 측정 명령 하나, 최소 사전 등록.
3. `omf goal tick` 1회차: 컨테이너에서 측정, 격차와 대역, reconcile(`intent.md` 후보, 결정론적 필터), 범위 안에서 자동 디스패치.
4. 항목마다 W: `decide`(`spec.md`, 원장), `seal`(Codex 일회성, 결정론적 CLI 시나리오, GATE-2), `run`(devcontainer의 Claude, `omf/<work-id>` 브랜치), `judge`(두 컨테이너, 게이트 라인, 결과 분류), 가린 피드백 한 라운드, `report`.
5. 사람이 병합한다. 선택적으로 `omf ship --open-pr` 을 쓴다.
6. `omf goal tick` 2회차: 다시 측정한다. 격차가 닫혔으면 후보를 만들고, 이어서 `omf goal sign`(J5)을 한다.
7. 자체 지표를 기록한다.
8. 강제 테스트:
   - `E1 metric-tamper-stops`
   - `E2 canary-no-leak`: 워크스페이스, 프롬프트, G 입력, 피드백을 다룬다
   - `E3 budget-no-reset`
   - `E4 unevaluated-is-undetermined`
   - `E5 init-non-pollution`
   - `E6 l2-leak-redteam`: 시나리오를 찾으라고 지시받은 구현자가 실패하고 카나리가 나타나지 않는다
   - `E7 empty-means-fail`: 시나리오 0개, 빠진 게이트, 없는 결과는 절대 통과하지 않는다
   - `E8 no-auto-approve`: TTY 없음, 맞지 않는 답, 타임아웃은 절대 승인으로 이어지지 않는다
   - CLI 사용법 드리프트 테스트와 요구사항-테스트 적합성 매트릭스(Kilroy 의 parity matrix)
9. `examples/hello-goal`: 오프라인으로 측정할 수 있는 지표를 가진 작은 CLI. 예를 들면 고정된 입력 집합에 대한 로컬 연산의 p95 지연이다. 외부 서비스 없이 전체 루프가 돈다.

**v0.1 범위 밖:**
- LLM 판정과 확률 구간.
- 선택적 프로토타입을 넘는 분기 탐침.
- 외부 트래커와 관측 MCP.
- 원격 러너와 L3.
- 디지털 트윈 유니버스.
- 스케줄링 (`omf goal tick` 을 cron이나 CI에서 쓰는 방법을 문서화하는 것은 제외).
- Claude Code와 Codex 셸.
- `migration` 템플릿.

**로드맵:**
- v0.2: 셸(플러그인과 스킬), GitHub 상태 어댑터, 예약 틱 워크플로 템플릿, SSH 서명 승인, 분기 탐침.
- v0.3: 순서를 바꾸는 LLM 판정, Wilson 구간을 쓰는 확률, 전체 래더(Ladder), L3, 매 실행 유출 레드팀.
- v0.4: 읽기 전용 MCP 측정 어댑터, E2B 러너, 첫 디지털 트윈 키트, `migration` kind.

## 14. 열린 질문

이 질문들은 미뤄 두며 v0.1을 막지 않는다.

1. 팀 사용: 한 목표에 여러 사람과 여러 머신이 붙는 경우. v0.1의 호스트 금고는 머신별이고, 팀 모드는 범위 밖이다.
2. 단일 벤더 사용자: 더 낮은 보장 라벨("same-vendor sealing", 같은 벤더 봉인)로 허용한다. 라벨의 정확한 문구는 미룬다.
3. 벤더를 달리한 작성이 유출이나 상관된 사각지대를 실제로 줄이는지. 가설로 두고 측정한다. 주장하지 않는다.
4. WIP 상한, `STOP_IF`, 래더 마진의 기본값은 시작점이며 자체 지표를 보고 조정한다.
5. Windows 지원(L1만?)과 사내 프록시.
6. **v0.1 결정(Kilroy 와 Arc 를 읽은 뒤):** W 는 OMF 고유의 결정론 상태기계로 돈다. Attractor DOT 는 v0.2 에서 내보내기·보기 형식으로만 검토한다. 이유는 셋이다.
   - Attractor 명세 자체가 바뀌어 왔다. Kilroy 는 예전 번들 판본을 구현했는데, 그 판본에서는 조건이 맞지 않으면 아무 엣지로나 넘어간다. 현재 명세는 아무 엣지도 고르지 않는다.
   - `goal_gate` 는 `PARTIAL_SUCCESS` 도 통과시키지만 OMF 게이트는 그러지 않는다.
   - OMF 보증의 대부분은 그래프 밖에 있다. 격리, 금고, 예산, 가림이 그렇다.

   Kilroy 에 의존하거나 포크하는 안은 기각한다. 비테스트 Go 코드만 약 5.5만 줄이고, OMF 는 TypeScript 패키지이며, Kilroy 의 권한·격리 기본값이 OMF 와 충돌한다. 대신 작은 아이디어만 가져온다(§10). 코드는 복사하지 않는다.
