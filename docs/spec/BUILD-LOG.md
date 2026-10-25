# BUILD-LOG

빌드 중 발견한 스펙과 현실의 차이, 결정, 막힌 지점을 적는다. 스펙 문서(00~10)는 고치지 않는다.

## 스펙 이슈 (통합 시점 2026-10-24 13:20 KST, `feat/integration`)

| # | 영역 | 스펙 | 현재 코드 | 채택한 해석 / 다음 할 일 |
| --- | --- | --- | --- | --- |
| 1 | 스타일 | Tailwind v4, `@theme` 토큰 (09) | Tailwind 3.4 + `tailwind.config.ts`가 `globals.css` 변수를 매핑 (앱 스캐폴드 세션) | 토큰 단일 출처(`globals.css`)라는 목적은 같아서 3.4 유지. 스펙 09의 v4 문구는 현실과 다름 |
| 2 | 컴포넌트 카탈로그 | `/demo/ui` (10 T01) | `/ui-kit` | `/ui-kit` 유지 |
| 3 | 브랜드 | Pibu | **결정됨 (2026-10-24, 오너): 화면에 보이는 이름은 전부 `PibooK`, 하이픈 없음, 한글은 `피북`.** 로고 마크 `app/icon.svg`(PK 모노그램), 공유 이미지, 스플래시의 K 강조 모션. `scripts/rename-brand.mjs`가 README, `PLANNING.md`, `DEMO.md`까지 옛 표기를 치환하고, `prebuild`가 옛 표기(`Pibuk`, `Pibu-k`, `PiBoo-K`)가 돌아오면 빌드를 실패시킴 | 프로토콜 식별자(`pibu/*@1` 스키마, `https://pibu.app/ext/*` 확장 URI, `pibuBearer`)와 코드 식별자(`PibuSchemaName` 등)는 스펙·메시지 규약과 맞추기 위해 유지. `docs/spec` 00~10은 이 문서 규칙대로 고치지 않아 아직 `Pibu` |
| 4 | 테마 | 무채색 코어 + `--brand` 1색 | 랜딩은 sunrise 그라데이션 라이트, 나머지는 다크 | 오너 결정 대기 |
| 5 | 의존성 | `@a2a-js/sdk`, `@anthropic-ai/sdk`, `jose`, `@playwright/test` (09) | 없음 | 에이전트 로직(T04~T08)을 붙이는 세션이 추가 |
| 6 | 백엔드 | `app/a2a/**`, `app/api/**`, `lib/agents/**`, `data/seed`, `lib/clock.ts` | 있음: `lib/store`, `lib/domain`(06 엔티티), `lib/a2a/{schemas,wire,mask,log}`, 시술 마스터 `data/seed/procedures.json`(27종), `lib/agents/platform/procedure-filter.ts`. 없음: `lib/clock.ts`, 병원·슬롯·가격 기록·결과 시드, `lib/a2a/{auth,cards,server,client}`, 에이전트 3종, `app/a2a/**`, `app/api/**` | T03 나머지와 T04~T08 담당 세션 필요. 시드 날짜와 07 판정은 스펙 갱신까지 보류 중 (백엔드 세션 `2-backend`) |
| 7 | 화면 데이터 | 스펙 06 필드명 | `lib/ui-data/*` 목데이터, `lib/domain`의 일부 타입만 import | 백엔드 연결 때 어댑터만 교체 |
| 8 | 온보딩 라우트 | `/[locale]/onboarding` 별도 화면 (05) | 랜딩이 곧 온보딩 채팅, `/[locale]/onboarding`은 랜딩으로 이동 | 앱 스캐폴드 세션 결정 채택 |
| 9 | ZK 레이어 | 스펙에 없음 | 팀원 `feat/zk-record-registry`를 `glowpass/`·`zk/`·`chain/`으로 통합 | 연동 방식은 [docs/INTEGRATION.md](../INTEGRATION.md). **스펙 반영 완료 (2026-10-24)**: 02, 03, 05, 06, 07, 08, 09, 10에 ZK 확장 (INTEGRATION.md가 설계 출처) |
| 10 | 시술 마스터 | 06 `Procedure`: 6종, 제품 단위 id (`rejuran_healer` 등) | `PLANNING.md` 부록 A 27종, 시술 단위 id (`rejuran` 등)로 교체. `lib/domain/procedure.ts`, `data/seed/procedures.json`. 정렬 후: 스펙 6종과 겹치는 항목은 스펙 id, 나머지는 시술 단위 id (`juvelook_eye` 등) | 03 예시와 06의 제품 단위 id가 마스터에 없었다(와이어 `procedureId`는 자유 문자열이라 동작은 깨지지 않았음). **결정됨 (2026-10-24, 오너: 정본은 스펙): 스펙 6종 id로 마스터 id 정렬** (`rejuran` → `rejuran_healer`, `thermage` → `thermage_flx`, `shrink` → `shrink_universe`, `botox_wrinkle` → `botox_forehead`, `juvelook` → `skin_booster_juvelook` 5건, `ulthera`는 그대로, 이름·값은 안 바꿈). 나머지 21종 id 유지. 병원 콘솔 목데이터의 `shurink_universe`도 `shrink_universe`로 맞춤. 값은 참고용 일반값이라 `verified: false` |
| 11 | 단위 | `Unit` = cc, shot, unit, line, session | `vial` 추가 (`lib/domain/common.ts`, `UnitSchema`) | 부록 A가 쥬베룩과 스컬트라를 바이알로 표기. 06 갱신 필요 |
| 12 | 지역 | 07 2절: 지역 하드 필터와 적합도 점수, 03: 후보 최대 5곳 | 오너 의견(2026-10-24): 지역은 조건이 아니라 위치 정보, 옵션은 3곳. 코드는 `areas`가 선택 필드이고 후보 상한 5라서 그대로 호환 | **결정됨 (2026-10-24 14:27 KST, 오너): 지역은 위치 정보, 후보 3곳.** 07 2절 하드 필터에서 지역 삭제, 적합도는 언어만, 상위 3곳. 유키 데모는 언어 필터로 같은 3곳이라 10의 데모 3행 설명만 수정 |
| 13 | 데모 기준 | 10: Yuki 리쥬란 11/13~15, 서울글로우·민트·아라, 기준일 2026-11-12 | DEMO.md 기준 시절의 기록 (오른쪽 칸 끝의 오너 재결정으로 대체됨): **결정됨 (2026-10-24, 오너 위임): `DEMO.md`가 데모 기준.** 말이 되는지 검증해 정한 것: (1) 데모 시계는 하나, `2026-10-24T10:00+09:00`(토). 오늘이라 발표일과 맞고 지수 메모 사진의 저장일과 같고 병원 콘솔이 이미 쓰는 값. (2) 이 시계로는 유키(10/11~13)와 그레이스(10/20~27)가 과거라서 요일을 유지한 채 +28일: 유키 11/8(일)~11/10(화), 첫 시술 11/10, 2회차 12/10. 그레이스 11/17(화)~11/24(화), 상담 11/18 14:00. 지수와 린은 그대로. (3) 유키 2회차는 원문(10/13 다음 11/13)이 30일 규칙이면 11/12로 하루 어긋났는데, 이동 후에는 12/10으로 30일 규칙과 달력 한 달이 일치. (4) 지수 리쥬란 다음 시기는 30일 규칙 12/10~1/9, 달력 3~4개월 12/11~1/11로 원문 "12월 중순~1월 중순"과 1~2일 차이. 스케줄 구현 때는 달력 월 계산을 쓴다 | `DEMO.md`의 유키·그레이스 날짜를 위 값으로 고쳐야 함(기획자 문서라 아직 안 고침). 병원 시드는 `DEMO.md`의 가상 병원으로 새로 만들어야 함. **오너 재결정 2026-10-24: 정본은 docs/spec. DEMO.md는 기획 서사. 데모 데이터(시드·목데이터·ZK 카탈로그)는 스펙 id 기준**. 시계 기본값 `2026-11-12T10:00+09:00`(스펙 06)로 코드 반영 완료, 테스트 일정 재이동 (유키는 스펙 10의 11/13~11/15로 옮겨 기대 일수 그대로, 그레이스 11/17~11/24는 새 시계 뒤라 유지) |
| 14 | 다운타임과 출국일 | 06: 출국 전 다운타임 미종료는 경고만. `PLANNING.md` 8-8: 제외 | **결정됨 (2026-10-24, 오너): 출국일을 넘으면 체류 연장이 가능한지 확인하라고 안내.** 필터는 가장 빠른 경우(도착일 시술, 최소 다운타임)에도 안 끝나면 제외하고 `extendDays`(연장해야 가능한 날수)를, 최대값 기준으로만 겹치면 경고와 `daysOver`를 돌려줌. `lib/agents/platform/procedure-filter-copy.ts`가 ko, ja, en, zh-CN 문장으로 바꿈 | 일본어와 중국어 문구는 원어민 검수 필요 |
| 15 | 시술 필터 | 스펙 02, 03, 07에 없음 (`PLANNING.md` 8-8 신규) | `lib/agents/platform/procedure-filter.ts`: 영역 40, 부위 20, 한국 여성 선택률 20, 예산 10, 통증 10 | 선택률 데이터(`kr-patterns`)는 아직 없어 호출자가 함수로 주입. 03에 해당 A2A 스킬이 없음: `platform.recipe`를 확장할지 새 스킬로 둘지 결정 필요 |
| 16 | 데모 시계 | 09: `lib/clock.ts` 하나, `DEMO_NOW` | `lib/clock.ts` 구현 완료(기본 2026-11-12T10:00+09:00, 스펙 06). 화면 쪽 상수는 아직 따로지만 값은 같음: 고객 `DEMO_TODAY`, 운영 `OPS_TODAY`, 병원 `TODAY` 모두 2026-11-12. 병원 목데이터 날짜는 +19일 옮겨 오늘과의 간격 유지, 민트 첫 방문 1cc 이벤트는 스펙 06 기간(11-01~11-30) | 세 상수의 값은 `clock`과 맞춤. 상수를 `clock`에서 읽도록 묶는 일은 UI 세션 몫으로 남음. 목데이터는 스펙 10 데모 기준이라 그대로. **2026-10-24 재결정에 따라 UI 목데이터는 당분간 스펙 시나리오(리쥬란, 스펙 id) 그대로 둔다** |
| 17 | 후기 공개 | 08 38행·42행: 후기 비공개 | glowpass는 원문 공개 (11fe512에서 잠시 집계만으로 바뀌었다가 복원) | **결정됨 (2026-10-24 13:23 KST 오너, 14:18 재확인): 후기 공개.** 로그인 고객·비교 화면에 원문과 집계, 랜딩 제외, 익명 집합 3명 이상, 보상 없음. 같은 날 docs/spec-zk-extension이 '집계만'으로 적은 것은 서브에이전트의 보수적 해석이었고 오너 결정이 아니었음 |
| 18 | 화면 문구 (ZK) | 05 `/[locale]/settings/data`: "기록 지갑" 카드 (가명, 온체인 차트 해시, 버전, 앵커 기록 수). 05 `/[locale]/records`·10 T17·10 데모 6장면: 출처 표시 "병원 확인 · 체인 기록 v{n}" | 카드 이름 "내 기록 보관함" (ja わたしの記録保管庫, zh-CN 我的记录保管箱, en My record vault), 행은 익명 ID · 위변조 확인 코드 · 병원 확인 기록 n건 (버전 행 없음, 내보내기 JSON에는 남음). 기록 화면 출처는 "병원 확인 · 위변조 방지" + tx 링크. 데모 `/demo/wallet`은 "브라우저 보관함", `/demo/ledger` 열 이름은 익명 ID · 위변조 확인 코드 | **결정됨 (2026-10-24, 오너): 화면에서 "지갑"·"가명"을 쓰지 않는다.** 개인키·코인 지갑으로 오해하기 쉬워서. 설계 문서(02, 03, 06, 08, 09, INTEGRATION.md)의 "지갑"은 같은 것을 가리키는 내부 용어로 두고, 코드 식별자(`wallet`, `ZkWallet`, `subjectId`)와 경로 `/demo/wallet`도 유지 |

## 통합 기록

- `main`(스펙) 위에 `feat/app-scaffold` → `feat/ui-customer` → `feat/ui-clinic` → `feat/ui-ops` → `feat/backend-skeleton` → `origin/feat/zk-record-registry` 순서로 머지. `feat/mvp-build`(스캐폴드 중복)는 제외.
- 충돌 해소: 랜딩·권익 안내·온보딩은 앱 스캐폴드 쪽(최신, 오너 지시 반영) 채택 후 고객 세션의 온보딩 완료 버튼·데모 날짜 고정을 다시 적용. `package.json`은 양쪽 의존성 합집합. README는 양쪽 절 유지.
- 팀원 GlowPass 서버는 `app/`(Next.js App Router 디렉토리와 충돌)에서 `glowpass/`로 이동. 경로가 `import.meta.url` 기준이라 동작 동일.
- 2026-10-24 재통합 (`feat/integration-r2`): `feat/integration-2` 위에 BUILD-LOG 기록, `feat/backend-skeleton` 최신(시술 마스터, 시술 필터, 데모 시계, 체류 연장 안내), `origin/main`(배포 메모), 브랜드 치환(`PibooK`)과 옛 표기 가드를 얹음. 게이트: typecheck, test, build, `verify-spec all`, 전 경로 스모크.

- 2026-10-24 스펙 개정 (`docs/spec-zk-extension`): ZK 기록 레이어를 스펙에 반영 (02, 03, 05, 06, 07, 08, 09, 10에 "ZK 확장": 새 스킬 `platform.anchor_record`·`platform.submit_review`, 확장 `zk-offer-proof/v1`, 스키마 3종, T16~T18). 시나리오·id의 정본은 docs/spec으로 재결정 (13행). 후기는 원문과 집계를 로그인 고객·비교 화면에 공개 (익명 집합 3명 이상, 오너 결정). 코드는 건드리지 않았다.

## 릴리스 브랜치 `feat/release` (2026-10-24 오후)

`feat/integration` 위에 올린 배포 후보. 같은 날 부분 브랜치에 생긴 커밋과 오너 지시를 반영했다.

- 머지: `feat/app-scaffold`(랜딩 히어로 2건, 충돌은 온보딩 파일의 가입 시트와 임포트 한 곳), `feat/backend-skeleton`(시술 마스터 27종, 플랫폼 시술 필터). 아직 커밋되지 않은 부분 세션 작업(앱 스캐폴드의 히어로 수정, 백엔드의 `lib/agents`와 `data/`)은 넣지 않았다.
- 가입: 랜딩의 [회원가입]을 누르면 로그인 블록이 가운데 모달로 열린다 (`components/customer/auth-dialog.tsx`). 이메일, 비밀번호, 가입 버튼, Google 버튼, 로그인 전환 링크, 데모 계정. 계정 백엔드가 없어서 모든 경로는 채팅 시작으로 이어진다. 디자인은 오너가 준 shadcn Login 블록의 구조를 따르되, 이 리포는 shadcn이 아니라서 기존 `components/ui`와 토큰으로 다시 만들었다. 의존성은 `react-icons`(Google 아이콘) 하나만 추가.
- 기본 언어: `/`는 항상 `/en`으로 간다 (오너 지시). 브라우저 언어 감지(04 문서)는 일부러 껐다. 되돌리려면 이전 `app/page.tsx`의 `pickLocale()`을 복원한다.
- 접근성: 푸터 언어 링크 폭을 44px로 맞췄다.
- 알려진 남은 것: 병원 콘솔 `/clinic/inbox` 데스크톱 폭의 체크박스 20px (병원 콘솔 세션 영역). 채팅 입력창은 바 전체가 터치 영역이다.
- 검사: CI와 같은 순서(`npm ci`, `typecheck`, `test` 112개, `build`와 가드 3종, `verify-spec`) 통과. 55개 라우트를 3개 폭으로 연 브라우저 검사에서 pageerror 0, 가로 넘침 0.

## 트랙 ZK

- GlowPass(`glowpass/**`)와 `zk/codes.json`을 팀원 `origin/feat/zk-record-registry` 최신(f8c0312, 스펙 id 정렬판)으로 맞췄다. 기준 브랜치에는 옛 가상 병원 판(`cln_hongdae_a` 등)이 들어 있었다. 팀원 파일에 한 변경은 `glowpass/wallet.mjs`의 `match-offers` 응답에 `procedureId` 추가 하나.
- `lib/zk`: GlowPass HTTP 클라이언트(타임아웃, 실패 시 `null`)와 PibooK 고객 id·고객 에이전트 id·병원 id → GlowPass id 표(`lib/zk/identity.ts`). `cus_jisoo`는 국내 거주라 표에서 뺐다.
- A2A 확장 `https://pibu.app/ext/zk-offer-proof/v1`: 증명은 `clinic.quote`의 `metadata.zkOfferProof`. 팀원 초안의 `metadata.offerProof` 봉투와 `EventSchema.zkClauses`·`offerApplied`는 `lib/a2a/schemas.ts`(공통, strict)를 바꿔야 해서 제안으로 남김. 할인 적용은 지금 스키마의 `event`로 표현. 상세: `docs/INTEGRATION.md` 3·4절.
- 스모크에서 찾은 것: 체인 기록이 없는 가명(유키·에밀리)은 온체인 commitment가 0이라 첫 방문 증명이 회로에서 실패한다 (`match-offers`는 `eligible: true`). 팀원 결정 필요. `docs/INTEGRATION.md` 7절.
## 트랙 CLINIC (2026-10-24, `feat/track-clinic`)

병원 에이전트(`lib/agents/clinic/**`)와 병원 콘솔 연결(`app/clinic/**`, `app/api/clinic/**`, `components/clinic/**`, `lib/ui-data/clinic.ts`).

| # | 영역 | 스펙 | 구현 | 이유 / 다른 트랙이 할 일 |
| --- | --- | --- | --- | --- |
| C1 | 병원 저장소 컬렉션 | 06: 엔티티 이름만 | 네임스페이스 `clinic`의 컬렉션: `profiles`, `operation`(카드 확장 params), `menu_items`, `offers`(+ `active`), `slot_policies`(id = 병원 id), `slots`, `bookings`, `tasks`, `quotes`. `CLINIC_COLLECTIONS`(`lib/agents/clinic/store.ts`) | A2A 트랙의 `loadSeed`는 `writeClinicSeed(store, seeds, slots)`(`lib/agents/clinic/seed.ts`)를 부르면 된다. 시드가 아직 없으면 `DEMO_MODE=true`에서만 06 시드 값(`fixtures.ts`)을 한 번 넣는다 |
| C2 | 시술 id | 06·03 예시는 `rejuran_healer`, 마스터는 `rejuran` (BUILD-LOG 10) | 픽스처는 06 값(`rejuran_healer`). 견적은 `procedureId` 문자열 일치로 고른다 | 시드와 고객 요청이 같은 id 체계를 써야 한다. 통일은 결정 6 이후 |
| C3 | 민트 메뉴 | 06: "1cc 이벤트만" | 이벤트(99,000, 정상가 150,000) + 같은 용량 정가 메뉴 1cc 150,000 | `Offer`에 `vatIncluded`, `product`, `includes`가 없어서 견적의 이 필드를 같은 시술·용량 메뉴에서 가져온다. 이벤트가 끝나면 정가 1cc로 답한다 |
| C4 | 카드 URL | 03: `/a2a/clinics/{slug}`, `cardUrl()`은 병원 id를 경로에 씀 | `card(agentId)`는 요청받은 경로 조각을 그대로 rpc URL에 쓰고, `exists`·`card`·스킬은 id와 slug를 모두 받는다 | 어느 쪽으로 불러도 그 카드의 rpc URL이 실제로 닿는다 |
| C5 | 추가 정보 요청 | 02: "추가 정보 필요 시 INPUT_REQUIRED" | `safetyInfo` 없이 온 `clinic.book`은 `INPUT_REQUIRED`(임신·수유, 알레르기). 콘솔의 [시간 제안]·[추가 정보 요청]도 `taskCompleter.complete`로 `INPUT_REQUIRED`를 써 넣고, 고객 답(`pibu/input-response@1`)을 받으면 다시 `WORKING` | `TaskCompleter.complete`를 종료 아닌 상태 전이에도 쓴다. A2A 코어 구현이 `INPUT_REQUIRED`와 `inputRequest`(status.message DataPart)를 받아야 한다 |
| C6 | 추천 토큰 검사 | 03: 서명·만료·aud | 더해서 `scope`(quote/book), `requestId` 일치, 견적은 `sub` = `customerAgentId` 일치. 검증 함수가 예외를 던지면 `FAILED` | 토큰은 요청 단위로 발급되므로 다른 요청에 재사용하면 거절 |
| C7 | ZK 오퍼 증명 | INTEGRATION 4절: `offerApplied` 필드 | `zkEnabled()`이고 `metadata.zkOfferProof`(번들 또는 `pibu/offer-proof@1` 래퍼)가 있을 때만 `verifyOffer` 후 `ok`면 이벤트가, 아니면 정가. ZK가 꺼져 있으면 동작 변화 없음 | `QuoteV1Schema`가 strict라 `offerApplied`를 넣지 못한다. 이벤트 유무가 할인 적용 여부. 필드가 필요하면 `lib/a2a/schemas.ts` 변경 요청 |
| C8 | 견적 유효기간 | 03 예시만 | 오늘 + 7일, 이벤트 종료일이 더 빠르면 종료일 | |
| C9 | 콘솔 되돌리기 | 목업: 확정 후 8초 되돌리기 | 제거 | 확정은 A2A 태스크 완료, 플랫폼 보고, 고객 알림까지 실제로 일어나서 되돌릴 수 없다 |
| C10 | 테스트 alias | | vitest 설정이 없어 `@/` alias가 테스트에서 안 풀린다. `lib/agents/clinic/**`는 상대 경로 import | 오케스트레이터가 `vitest.config.ts`(tsconfig paths)를 추가하면 다른 트랙도 편해진다 |
## 트랙 OPS (2026-10-24, `feat/track-ops`)

개선 루프(07 4절), 운영 API, 데모 컨트롤. 스펙과 다르거나 스펙이 정하지 않은 것만 적는다.

| # | 영역 | 스펙 | 구현 | 다음 할 일 |
| --- | --- | --- | --- | --- |
| O1 | 저장소 컬렉션 이름 | 06에 없음 | `platform`: `clinic_registry`, `outcomes`, `signals`, `routing_rules`, `routing_rule_history`, `match_logs`, `attributions`, `price_records` (`lib/agents/platform/signals.ts`의 `PLATFORM_COLLECTIONS`). `clinic`: `bookings`, `profiles` (`app/api/ops/_lib/bookings.ts`) | 시드 로더(A2A)와 병원 에이전트(CLINIC)가 같은 이름을 써야 운영 화면에 데이터가 보인다. 합칠 때 한 곳으로 모은다 |
| O2 | 규칙 버전 | 07 가드레일 5: 변경마다 버전 증가 + 이력 | 상태가 바뀔 때마다 `version + 1`, 전체 사본을 `routing_rule_history`(`<id>@v<n>`)에 저장. `exclude_clinic`은 승인 시 `expiresAt = 승인 + 90일`, 지나면 다음 조회나 제안 실행 때 `system`이 `retired`로 바꾼다 | 매칭(`rules.ts`)은 `status = active`만 읽으면 된다 |
| O3 | 국적 가드레일 해석 | 07 가드레일 1 | 국적 조건이 있으면 `boost_clinic` 금지, `exclude_clinic`·`demote_clinic`은 그 병원·그 국적의 피해 근거(실결제 +10% 초과, 만족도 2 이하, 부작용, 또는 그 병원의 피해 신호)가 있어야 통과. `require_language`·`prefer_area`는 근거 없이 허용. 건강 정보 키나 가격 관련 키·행동은 어디에 있어도 버린다 | |
| O4 | Claude 출력 | 07: 사유·요약 작성, 추가 제안 2개 | 후보의 `when`/`then`을 바꾼 초안은 버리고, 요약이 트리거의 숫자(예: 31, 20)를 그대로 담지 않으면 템플릿 요약을 쓴다. 픽스처 키 `proposer`, 도구 `propose_rules({ rules: [{ candidateKey?, when, then, reason, evidence }] })`, 후보 키 형식 `quote_gap:cln_ara:JP` | LLM 트랙 픽스처가 이 모양을 따라야 `mode: "claude"`가 된다. 다르면 템플릿으로 떨어진다 |
| O5 | 긴급 정지 | 07 가드레일 4 | 부작용 트리거는 레지스트리 `verificationStatus`를 즉시 `suspended`로 바꾸고 긴급 제안(`urgent: true`)을 만든다. 운영자가 반려하거나 폐기하면 이전 상태로 되돌린다. 같은 근거로 반려된 규칙은 다시 제안하지 않는다 | |
| O6 | 응답 없음 비율 | 07: 시간초과 비율 | 분모는 A2A 로그의 `clinic.quote` 호출 수(국적은 요청 `visitorProfile.nationality`), 분자는 `response_timeout` 신호(국적이 없으면 `taskId`로 로그에서 찾음) | |
| O7 | 결과 주입 | 06: `outcomes-ara-burst.json` | 파일이 있으면 필드를 쓰되 날짜·간격·실결제는 주입 시점 `clock.now()` 기준으로 다시 계산. 없으면 코드에서 같은 20건을 만든다(`procedureId: "rejuran"`, 견적 330,000원 VAT 포함 기준). 신호 `quote_gap` 20건도 함께, `PriceRecord`는 만들지 않는다 | |
| O8 | 예약 거절 | 계약에 `confirmBooking`만 있음 | 병원 모듈이 `rejectBooking(clinicId, bookingId, by, reason)`을 내보내면 그것을 부르고, 없으면 `taskCompleter.complete(..., REJECTED)` 후 예약을 `canceled`로 저장 | CLINIC 트랙에 `rejectBooking` 추가 요청 |
| O9 | 운영 접근 | 운영자만 | `getSessionUser()`가 `operator`면 통과. `DEMO_MODE=true`면 로그인 여부와 관계없이 `demo_operator`로 통과(데모 iframe이 고객으로 로그인해 같은 쿠키를 쓰기 때문). 데모가 아니면 비로그인 401, 다른 역할 403 | |
| O10 | 데모 시계 프리셋 | 05·10: 11/12, 11/14 | `lib/clock.ts` 기본값(10/24) 기준으로 10/24 시작, 11/10 13:00(유키 시술, BUILD-LOG 13), 11/14 13:00(10의 6행), 12/10 10:00 | 10의 시나리오 표가 BUILD-LOG 13으로 갱신되면 프리셋도 맞춘다 |
| O11 | 데모 오른쪽 패널 | 05: 병원 요청함 [확정] [시간 제안] [거절] | 직접 운영 병원은 [확정]만 두고 시간 제안·거절은 `/clinic/inbox` 링크로 보낸다(그 API는 CLINIC 트랙). 가운데 로그는 재생 목업 대신 `GET /api/ops/a2a-log`를 2초마다 읽는다 | |
| O12 | 테스트 import | | vitest 설정에 `@/` 별칭이 없어 이 트랙의 서버 코드와 테스트는 상대 경로를 쓴다 | `vitest.config.ts`에 tsconfig 경로를 넣으면 정리 가능 |
## 트랙 AUTH (계정·DB, `feat/track-auth`, 2026-10-24)

### 만든 것

- DB: Drizzle ORM. `DATABASE_URL`이 있으면 `@neondatabase/serverless` Pool(트랜잭션 가능), 없으면 PGlite를 `.data/pglite`에 저장. Vercel에서 `DATABASE_URL`이 없으면 메모리 PGlite + 경고 로그(인스턴스가 바뀌면 계정이 사라짐). 스키마 `lib/db/schema.ts`, 마이그레이션 `drizzle/`, 첫 사용 때 자동 적용(`lib/db/migrate.ts`, 기록 테이블 `__pibook_migrations`, advisory lock으로 동시 콜드 스타트 직렬화). 서버 번들이 폴더를 못 실을 수 있어 SQL을 `lib/db/migrations.gen.ts`에 임베드한다. 스키마를 바꾸면 `npx drizzle-kit generate` 다음 `node lib/db/embed-migrations.mjs`(검사: `--check`).
- 저장소: `lib/store/pg.ts`가 `Store` 계약을 JSONB 테이블 `store_items(namespace, collection, id, data, position)` 위에 구현. `getStore()`는 테스트(vitest)와 `next build`에선 메모리, 그 외(next start, next dev, Vercel)엔 Postgres. `PIBOOK_STORE=memory|pg`로 강제 가능. `resetStore()`는 시그니처 그대로 동기: Postgres에선 초기화를 큐에 넣고 이후 호출이 그걸 기다린다. 두 구현을 같은 계약 테스트로 돌린다(`lib/store/pg-contract.test.ts`).
- 계정: Better Auth 1.7.12, 이메일+비밀번호(8~128자), Google은 `GOOGLE_CLIENT_ID`와 `GOOGLE_CLIENT_SECRET`가 둘 다 있을 때만(버튼도 그때만 보임). 라우트 `/api/auth/*`, UI용 `/api/auth/options`. 쿠키 접두사 `pibook`. 가입하면 `cag_` + 10자 가명 에이전트 id를 만들고 역할 `customer`로 묶는다(가입 본문의 role·agent id는 무시). `customer/accounts/{userId}`에 `CustomerAccount`를 쓴다.
- 데모(`DEMO_MODE=true`): 계정 Yuki `cus_yuki`/`cag_7f3k2`, Lin `cus_lin`/`cag_4n8vd`, Emily `cus_emily`/`cag_2q9wk`, 지수 `cus_jisoo`/`cag_8h3tb`(UI 목데이터·A2A 픽스처와 같은 id), 병원 직원 `stf_seoul_glow`(clinic_staff, `cln_seoul_glow`), 운영자 `opr_demo`. 이메일은 전부 `*.demo@example.com`. 비밀번호 없는 데모 로그인 `POST /api/auth/demo/sign-in { "persona": "Yuki" | "lin" | "seoul_glow_staff" | "operator" ... }`, DEMO_MODE가 아니면 404.
- 화면: 랜딩 가입 모달(`components/customer/auth-dialog.tsx`, props 그대로), `/[locale]/signup`(비밀번호 칸 추가), 새 `/[locale]/login`. 문구는 `components/auth/copy.ts`(4개 언어). 브라우저 헬퍼 `components/auth/client.ts`(`signOut()`, `fetchMe()` 등 다른 트랙도 사용 가능).
- `proxy.ts`(Next 16): 로그아웃 상태로 고객 앱 경로(`/{locale}/home|chat|requests|bookings|records|outcomes|settings/**`)에 오면 `/{locale}?auth=login&next=...`로 보내고, 모달이 그 쿼리로 스스로 열려 로그인 뒤 `next`로 돌아간다. DEMO_MODE에서도 같다(데모 버튼이 비밀번호 없이 바로 로그인). `/clinic/**`·`/api/clinic/**`는 clinic_staff, `/ops/**`·`/demo/**`·`/api/ops/**`·`/api/demo/**`는 operator. 페이지는 `/ko/login?next=...`(역할이 틀리면 `&denied=1`), API는 401/403. DEMO_MODE면 열어 두고 요청에 `x-pibook-demo-as` 헤더를 붙여 `getSessionUser()`가 데모 직원·운영자를 돌려준다. 이 헤더는 모든 요청에서 먼저 지운다. proxy는 DB를 열지 않는다(Next 문서: proxy는 렌더 코드와 따로 돈다): Better Auth의 서명된 쿠키 캐시(5분)로 역할을 읽고, 만료됐으면 `/api/auth/get-session`에 묻는다.

### 다른 트랙용 계약

- `getSessionUser(headers?)`(`lib/auth/session.ts`, 시그니처 그대로): 인자 없으면 `next/headers`의 현재 요청 헤더. DB 세션을 직접 확인한다(쿠키 캐시 미사용이라 계정 삭제·로그아웃이 즉시 반영). DEMO_MODE의 콘솔 대체 사용자는 위 proxy 헤더가 있을 때만.
- `GET /api/me` → `{ account: { id, email, name, customerAgentId, role, clinicId?, createdAt }, profile: CustomerProfile | null }`, 로그아웃이면 401.
- `PUT /api/me/profile` 본문 = 06의 `CustomerProfile`(strict zod, `lib/auth/profile.ts`). `id`·`agentId`는 서버가 계정에서 채운다(보내려면 계정 값과 같아야 하고 다르면 403). 오타 필드·잘못된 enum·출국일<입국일은 400 + `issues`. customer 역할만. 저장 위치 `customer/profiles/{userId}`. **LLM 트랙: 온보딩 완료 시 여기로 저장한다.** 동의 원장·과거 시술은 이 API가 받지 않으니 고객 에이전트 쪽에서 `customer/consents`, `customer/records` 등에 `customerId = account.id`로 쓴다. `GET /api/me/profile` → `{ profile }`.
- `DELETE /api/me`: 세션 종료 쿠키 + 사용자·세션·로그인 연결 삭제 + `customer` 네임스페이스에서 이 고객 것 전부 삭제(`lib/auth/purge.ts`): `id == userId`, `customerId == userId`, `agentId`/`customerAgentId == cag`, 그리고 `requestId`·`bookingId`로 연결된 문서(견적·예약·결과 초안). **CUSTOMER 트랙: 고객 문서에는 `customerId`(계정 id)를 넣어야 삭제 대상에 잡힌다.** 다른 네임스페이스(플랫폼 익명 표본 등)는 건드리지 않는다.
- 데모 리셋(OPS): `resetStore()` 뒤 `loadSeed(getStore())`. Postgres에서도 동작한다. 계정 테이블은 리셋 대상이 아니다(데모 계정은 로그인할 때 없으면 다시 만든다).

### 환경 변수 (새로 씀, `.env.example`은 공용이라 여기만 적음)

| 이름 | 용도 |
| --- | --- |
| `DATABASE_URL` | Neon Postgres 연결 문자열. 없으면 PGlite |
| `PGLITE_DIR` | PGlite 폴더(기본 `.data/pglite`), `memory`면 메모리 |
| `BETTER_AUTH_SECRET` | 세션 서명 비밀값(32바이트 이상, `openssl rand -base64 32`). 비어 있으면 DEMO_MODE나 개발에서만 코드의 dev 전용 값을 쓰고 경고, 프로덕션이면서 DEMO_MODE가 아니면 첫 인증 요청에서 에러 |
| `BETTER_AUTH_URL` | 공개 주소(예: `https://pibook.vercel.app`). 비우면 요청에서 추론(로컬은 그대로 둬도 됨). Google 콜백이 정확하려면 배포에선 설정 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | 둘 다 있을 때만 Google 로그인 |
| `PIBOOK_STORE` | `memory` 또는 `pg`로 저장소 강제(디버그용) |

### 오너가 할 일: Google OAuth 클라이언트 만들기

1. https://console.cloud.google.com/ 에서 프로젝트 선택(없으면 생성).
2. "API 및 서비스" > "OAuth 동의 화면": 사용자 유형 외부, 앱 이름 `PibooK`, 지원 이메일, 범위는 기본(`openid`, `email`, `profile`). 테스트 단계면 테스트 사용자에 시연 계정 추가.
3. "사용자 인증 정보" > "사용자 인증 정보 만들기" > "OAuth 클라이언트 ID" > 애플리케이션 유형 "웹 애플리케이션".
4. 승인된 자바스크립트 원본: `http://localhost:3000`(로컬), 배포 주소(예: `https://pibook.vercel.app`).
5. 승인된 리디렉션 URI: `http://localhost:3000/api/auth/callback/google`, `https://<배포 주소>/api/auth/callback/google`. 포트를 바꿔 띄우면 그 포트도 추가.
6. 발급된 클라이언트 ID·보안 비밀을 `.env`(로컬)와 Vercel 환경 변수에 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`로 넣고, 배포에는 `BETTER_AUTH_URL`도 넣는다. 저장소·문서에는 값을 쓰지 않는다.

### 스펙과 다른 점·결정

| # | 내용 | 결정 |
| --- | --- | --- |
| A1 | 06: Postgres는 P1 | 지금 붙임. 메모리 저장소는 테스트·빌드 전용 |
| A2 | 05: `/[locale]/signup`은 이메일만 | 실제 계정이라 비밀번호 칸 추가. 로그인 화면 `/[locale]/login` 신설(콘솔 직원 로그인 겸용) |
| A3 | 랜딩 문구 `demoNote`("실제 계정은 만들지 않음", `landing-copy.ts`)가 이제 틀림 | 모달은 내 문구(`components/auth/copy.ts`)를 쓴다. `landing-copy.ts`의 `demoNote`는 남는 값이라 소유 트랙이 지워도 됨 |
| A4 | 저장값 | JSON 왕복이라 `undefined` 값 키는 저장되지 않는다(메모리 저장소는 남김). 필터 결과는 같다. Date 객체 대신 ISO 문자열을 쓴다(스펙 타입이 이미 그렇다) |
| A5 | Better Auth 시간 | 세션 만료는 실제 시간(Date.now). 데모 고정 시계(`lib/clock.ts`)는 도메인 데이터에만 쓴다. `CustomerAccount.createdAt`은 `clock.nowIso()` |
| A7 | 로그아웃 뒤 열린 앱 화면 | 로그아웃한 화면이 그대로 열려 있으면 Next 링크 프리페치가 proxy 리다이렉트를 받아 콘솔에 404 리소스 오류가 남는다(실측). 로그아웃 버튼은 `signOutAndLeave(locale)`(`components/auth/client.ts`)로 전체 페이지 이동을 해야 한다. **CUSTOMER 트랙: 설정 화면 로그아웃에 이 함수를 쓴다** |
| A6 | 검증 범위 | Neon 경로는 타입·코드만 확인했고 실제 Neon DB로는 돌려보지 못했다(연결 문자열 없음). Vercel 서버리스에서 PGlite wasm 파일 추적도 미확인: 배포는 `DATABASE_URL` 설정을 권장 |
## 트랙 A2A (A2A 코어 · 플랫폼 에이전트 · 시드, `feat/track-a2a`, 2026-10-24)

| # | 영역 | 스펙 | 구현 | 이유 / 다른 트랙이 알 것 |
| --- | --- | --- | --- | --- |
| A1 | A2A 서버 | 09: SDK `DefaultRequestHandler` + `InMemoryTaskStore` + `JsonRpcTransportHandler` | **SDK를 쓰지 않고 스펙 준수 핸들러를 직접 구현** (`lib/a2a/server.ts`). `@a2a-js/sdk` 1.3.0의 d.ts를 읽고 판단 | SDK는 태스크와 blocking 대기를 프로세스 메모리(`InMemoryTaskStore`, `ExecutionEventBus`)에 두어 서버리스 인스턴스 사이 `GetTask` 폴링이 깨지고, 실행기 안에서 SDK 내부 타입(`$case` Part, 숫자 상태)을 써야 하며, `-32602` 라우팅 실패를 태스크 생성 전에 답하기 어렵다. 직접 구현은 와이어 JSON만 다루고 태스크를 `getStore()`에 둔다. 메서드는 `SendMessage`, `GetTask`, `CancelTask`. 스트리밍·푸시·`ListTasks`는 `-32004` |
| A2 | 태스크 저장 | 09 함정 4: 에이전트별 `InMemoryTaskStore` | `shared` 네임스페이스 `a2a_tasks` 컬렉션 (`lib/a2a/tasks.ts`). 레코드마다 `owner`(답하는 에이전트)와 `caller`(토큰의 호출자) 저장 | AUTH가 Postgres 저장소를 붙이면 인스턴스 사이에서도 폴링이 동작. 다른 호출자의 태스크는 `-32001`(존재 여부도 숨김). 나중 완료는 `taskCompleter.complete(self, taskId, result)`: `self`가 owner가 아니면 throw, terminal이면 throw |
| A3 | 로그 중복 | 10 T04: rpc 라우트에 직접 POST하면 `A2ALogEntry` 1건. 09: 클라이언트가 모든 호출 기록 | 서버와 클라이언트가 **같은 id**로 기록한다. 클라이언트가 `Pibu-Log-Id` 헤더로 id를 보내고, 서버가 그 id로 먼저 쓰고, 클라이언트가 같은 id로 덮어쓴다 | 같은 프로세스에서도 호출 1건 = 로그 1건. 외부에서 직접 POST해도 서버 기록 1건이 남는다. 시간초과·JSON-RPC 에러도 기록 (`response.error`) |
| A4 | 에러 코드 | 03: `-32602`만 명시 | 토큰 없음·무효 HTTP 401 + `-32010`, 역할 불가 HTTP 403 + `-32011` (둘 다 JSON-RPC 서버 범위의 구현 정의 코드, A2A의 -32001~-32009와 겹치지 않음). `A2A-Version` 헤더 없음 또는 1.0 아님 `-32009`(헤더 없음은 0.3으로 읽는다는 A2A 규칙). terminal 태스크에 이어 보내기 `-32004`, 취소 불가 `-32002`, 파싱 실패 `-32700` | 다른 트랙은 `lib/a2a/client.ts`만 쓰면 헤더가 자동으로 붙는다. 에러는 `A2AError { code, data, httpStatus }`, 시간초과는 `A2ATimeoutError` |
| A5 | 호출자 역할 | 03: 병원 토큰으로 `customer.checkin` 거절 | `ALLOWED_CALLERS` 표 (`server.ts`): recipe·match·judge·submit_outcome·report_signal은 customer, report_booking은 clinic, clinic.offers는 platform·customer, clinic.availability는 customer·platform, quote·book·cancel은 customer, customer.notify는 clinic·platform, customer.checkin은 platform | 역할은 토큰에서만 읽는다. 스킬 안에서도 다시 검사 (예: submit_outcome은 예약의 customerAgentId와 토큰 sub 비교) |
| A6 | returnImmediately | 03: false면 terminal 또는 interrupted까지 응답 보류 | false면 핸들러 실행 후 상태가 WORKING이면 저장소를 250ms 간격으로 보며 최대 `A2A_BLOCKING_WAIT_MS`(기본 15초, 클라이언트 20초 제한보다 짧게) 기다린 뒤 현재 상태로 답한다. true면 핸들러가 돌려준 상태로 즉시 답한다 | 무한 대기는 서버리스에서 불가능해서 상한을 뒀다. `clinic.book`, `customer.checkin`은 클라이언트가 항상 true로 보낸다 (`buildSendMessageRequest`) |
| A7 | 시계와 시드 날짜 | 06: 시드는 기준일 2026-11-12로 생성 | **시드는 실제 시계 `lib/clock.ts` DEFAULT_DEMO_NOW 2026-10-24에 맞추되, 06 기준일 2026-11-12에서도 같은 결과가 나오는 날짜만 썼다.** 리쥬란 표본 42건 2026-07-16~10-22 (두 시계 모두 120일 안), 아라 JP 결과 4건 2026-08-16~09-20 (두 시계 모두 31~90일 전), 민트 1cc 이벤트 2026-10-01~11-30 (06의 11-01~11-30이면 10-24에 이벤트가 없어 민트가 견적을 거절), 슬롯 2026-10-26~11-30 매일 4개 (06은 11-10~11-30), `cus_yuki_done` 체류 2026-11-08~11-10 (BUILD-LOG 13의 +28일 이동, 06은 11-13~11-15) | 다른 트랙 테스트가 어느 시계를 고정해도 n = 42, 아라 플래그, 민트 이벤트가 유지된다. `data/seed/seed.test.ts`가 두 시계 모두 검사 |
| A8 | 시술 id | 03·06 예시 `rejuran_healer` | 시드와 판정은 마스터 id `rejuran` (제품명은 `product: "Rejuran Healer"`) | HANDOFF 7절 결정 6 권하는 안. 와이어 픽스처(`lib/a2a/__fixtures__/wire.ts`)는 그대로 둠 |
| A9 | 통상 용량 | 07: n < 10이면 시술 마스터 `typicalAmount` | 27종 마스터에 `typicalAmount`가 없어 `fairness.ts`의 `FALLBACK_TYPICAL_AMOUNT`(리쥬란 2~3cc 등, 데모용 값) 사용. 모르는 시술은 견적 용량을 통상으로 봐 `within` | 마스터에 필드가 생기면 그쪽으로 교체 |
| A10 | 이상치 신호 | 07: 이상치는 표본에서 빼고 `Signal`로 남김 | 표본에서만 뺀다. `Signal.kind`에 이상치 종류가 없고 `lib/domain`은 공통 파일이라 추가하지 않았다 | 시드에는 이상치가 없다. 종류 추가는 계약 변경 요청 |
| A11 | 제품 필터 | 07: 견적에 product가 있으면 같은 제품 표본으로 한 번 더 거름 | `pibu/judge-request@1`의 quotes에 product 필드가 없어 적용 불가 (`buildSample`은 product 인자를 받을 수 있게 둠) | 스키마에 product가 생기면 연결 |
| A12 | 매칭 세부 | 07 2절 | **(이식 기록 P1로 대체: 지역 하드 필터 제거, 상한 3)** 지역 하드 필터와 후보 상한 5는 07 그대로 (BUILD-LOG 12의 3곳·지역 제거는 07 갱신 전이라 미적용, 유키는 어차피 3곳). 07에 없는 세부: 요청 지역이 비면 지역 점수 1.0, 결과·신뢰성은 그 병원의 전체 결과, 시간초과 비율 = `response_timeout` 신호 수 / 과거 shortlist 등장 횟수, `priceReference`는 요청 첫 지역의 그룹(n < 5면 seoul), 점수는 소수 4자리로 정렬 후 출력 2자리, `filtered`는 clinicId 순 | 유키 요청: 서울글로우 0.79, 민트 0.66, 아라 0.66 순 (규칙 전 0.7946 · 0.6630 · 0.6628), `appliedRuleIds = []`, 한빛(지역)·다혜(일본어 app_translation만) 제외 |
| A13 | 병원 라우트 세그먼트 | 03: `/a2a/clinics/{slug}` | slug(`mint`)와 clinic id(`cln_mint`) 둘 다 받는다. 라우트가 clinic id로 바꿔 `definition.exists/card(clinicId)`와 `SkillContext.self.agentId`에 넘긴다 | `cardUrl(base, { role: "clinic", agentId: "cln_mint" })`가 만드는 id 경로도 동작. CLINIC 트랙의 정의는 clinic id 기준으로 구현하면 된다 |
| A14 | 유치 귀속 | 03: 추천 토큰 72시간 | `platform.report_booking`은 서명·aud·sub만 보고 만료는 허용 (`verifyReferralTokenForAttribution`) | 병원이 유효할 때 받은 토큰이므로 확정 보고가 늦어도 귀속한다. 견적·예약 검증은 만료를 거절하는 `verifyReferralToken` |
| A15 | 결과 제출 | 07 3절 | 귀속(report_booking)이 먼저 있어야 받는다. 없으면 REJECTED. 재제출은 같은 Outcome id로 덮어쓰고 이전 값은 `platform/outcome_history`. PriceRecord는 예약당 1건(`pr_<bookingId>`), 신호 id는 `sig_<outcomeId>_<kind>`라 재제출에 중복되지 않는다. 견적가는 `JudgedQuote`(matchId + clinicId), 없으면 예약의 priceKrw | |
| A16 | 비밀값 | 09 env | `A2A_TOKEN_SECRET`(32자 이상), `REFERRAL_PRIVATE_JWK`/`REFERRAL_PUBLIC_JWK`가 없으면 `DEMO_MODE=true`에서만 프로세스별 랜덤 비밀·키쌍을 만든다. 아니면 에러 | 여러 인스턴스 배포에서는 env 필수 (인스턴스마다 키가 다르면 토큰 검증 실패) |
| A17 | 저장소 컬렉션 | 06에 이름 없음 | `data/seed/load.ts`의 `SEED_COLLECTIONS`가 정본. platform: `clinic_registry, price_records, outcomes, outcome_history, rules, signals, match_logs, attributions, judged_quotes, offer_cache` · clinic: `profiles, menu_items, offers, slot_policies(id = clinicId), slots` · customer: `accounts, profiles, consents, records` · shared: `a2a_log, a2a_tasks, meta` | `ensureSeeded(store)`가 `shared/meta/seed` 표식이 없을 때 한 번 시드한다. A2A 라우트가 매 요청 호출. 데모 리셋은 `resetStore()` 후 다음 요청에서 다시 시드되거나 `loadSeed` 직접 호출 |
| A18 | 시드 파일 | 06 시드 표 | `clinics.json`(레지스트리+프로필+메뉴+오퍼+슬롯 정책, 실명·실주소 없음), `slots.json`(규칙만 적고 로더가 720개로 펼침), `price-records.json`(`scripts/gen-price-records.mjs`), `outcomes.json`·`outcomes-ara-burst.json`(`scripts/gen-outcomes.mjs`, 버스트는 `araBurstOutcomes(clock.now())`로 날짜 계산), `customers.json`, `rules.json`, `fx.json`(데모용 고정 환율) | 생성 스크립트는 `--check`로 파일이 최신인지 검사 (seed 테스트가 실행). 명동 리쥬란 14건은 p75 204,000 < 210,000 <= p90 211,800이 되게 만들어, 07 표의 한빛(2cc 420,000) `high`가 고정 표본뿐 아니라 실제 시드 판정에서도 나온다 |
| A19 | 테스트 위치·별칭 | | 테스트는 코드 옆 `*.test.ts`. vitest 설정이 없어 `@/` 별칭이 테스트에서 풀리지 않으므로 이 트랙 파일은 상대 경로 import | `vitest.config.ts`에 `@` 별칭 추가를 오케스트레이터에 요청 |
## 트랙 LLM (2026-10-24, `feat/track-llm`)

만든 것: `lib/llm` (runClaude, 픽스처, 프롬프트, 의료 경계 가드), `POST /api/onboarding/customer` (SSE), `POST /api/intent`, `platform.recipe` (`lib/agents/platform/recipe.ts`, `data/seed/kr-patterns.json`), 랜딩 채팅을 API로 연결.

| # | 영역 | 스펙 | 구현 | 이유 / 다음 할 일 |
| --- | --- | --- | --- | --- |
| L1 | 픽스처 강제 | 09: 키 없으면 데모 모드 | 키가 있으면 실호출, `LLM_MODE=fixtures`면 키가 있어도 픽스처, vitest에서는 항상 픽스처 | `DEMO_MODE=true`는 이미 고정 시계 뜻이라 겹치지 않게 분리 |
| L2 | 도구 강제 | 09: `draft_procedure_request` 등 "출력 강제" | Sonnet 5.5, Opus 5.5, Haiku 5.5는 `tool_choice: tool/any`가 400. `toolChoice`는 `auto` + 시스템 프롬프트 지시로 바꾸고, 서버가 호출 여부와 입력을 zod로 검증, 실패하면 픽스처 | API 제약 |
| L3 | 도구 에러 재질문 | 04: 검증 실패는 도구 에러로 돌려 Claude가 다시 묻게 | `runClaude`의 `messages`가 문자열만 받으므로 `[tool_error] ...` 사용자 메시지로 1회 재호출. 유효한 패치는 남긴다 | 계약 시그니처 유지 |
| L4 | `text` 토큰 | 04: SSE `text` 토큰 | 모델 응답을 다 받은 뒤 서버가 6글자씩 잘라 스트리밍 | 실토큰 스트리밍은 `RunOptions`에 선택 필드(`onText`)가 필요. 계약 변경 요청으로 올림 |
| L5 | 통상 용량 | 06: `Procedure.typicalAmount`, 07: 레시피가 돌려줌 | 시술 마스터(`procedures.json`, A2A 소유)에 없어서 `kr-patterns.json`의 `procedures`에 넣음 (`demo_assumption`). 공유 기록이 10건 이상이면 p25~p75 | 마스터에 옮길지 A2A 트랙과 결정 |
| L6 | 쥬베룩 볼륨 단위 | `DEMO.md`: 2cc | 마스터 단위(바이알)를 따라 통상 1~2바이알 | BUILD-LOG #11과 같은 문제. 마스터 단위가 정해지면 시드 수정 |
| L7 | 레시피 주기 | 03: `maintenanceIntervalDays` 필수 | 마스터 값이 null(초기 시리즈만 있는 시술)이면 `{0,0}` = 유지 주기 없음. 효과 시기는 마스터 `effectOnset` 구간을 일수로 (즉시 0, 1주 3~14, 2~4주 14~28, 서서히 30~90). 마스터 `count`가 null이면 `initial` 생략 | 03 스키마에 null 허용 여부 결정 필요 |
| L8 | 민감정보 동의 거부 | 06: `CustomerProfile.safety` 필수 | 동의를 거부하면 안전 정보를 모르므로 `safety`를 빼고 보냄 (`CustomerProfileBody`). 임의의 `false`를 만들지 않음 | 06 타입에서 `safety`를 선택으로 바꾸는 계약 변경 요청 |
| L9 | 프로필 저장 | 04: 완료 시 저장 | 서버가 고객 쿠키를 넘겨 `PUT /api/me/profile`(AUTH)을 호출. 401·404·405면 `saved: "demo_fallback"`, 화면은 브라우저 데모 상태 유지 | 브라우저 콘솔에 404가 찍히지 않게 서버에서 호출 |
| L10 | 요청 정리 위치 | 09: `lib/agents/customer/intent.ts` | `lib/llm/intent.ts` + `POST /api/intent` | 소유 경로(BUILD-TRACKS). 고객 에이전트는 `draftProcedureRequest`를 import하고 `typicalAmount`에 A2A `platform.recipe` 호출을 넣으면 됨 |
| L11 | 국적 "기타" | 04: ISO 코드 | 칩 "기타"는 `ZZ`(ISO 사용자 지정 코드)로 저장 | 국가를 자유 입력으로 받는 단계는 P1 |
| L12 | 시술 이름 | 마스터: ko, en만 | `lib/llm/procedure-names.ts`에 ja, zh-CN 이름과 고객이 쓰는 표기 추가 | 일본어·중국어 원어민 검수 필요 |
| L13 | 데모 날짜 | 04 예시: 11/13~15 | BUILD-LOG #13대로 유키 11/8~11/10, 데모 시계 10/24 | |
| L14 | 가격 기록 컬렉션 | 06: `PriceRecord` (platform) | 레시피가 `platform/price_records`를 읽는다고 가정, 없으면 시드 값 | A2A 트랙 시드 컬렉션 이름과 맞출 것 |
| L15 | 의료 경계 | 08 6절 | `lib/llm/guard.ts` 금지 패턴(진단·금기 판단·권유·효과 보장, 4개 언어). 실호출 출력이 걸리거나 민감정보 동의 전에 건강 주제를 꺼내면 그 턴은 픽스처 문장으로 교체. `DEMO.md`의 "팔자에 특히 잘 맞아요", "좋은 선택이에요" 같은 문장은 오프너 픽스처에서 데이터 인용으로 바꿈 | 스펙 08의 `tests/medical-boundary.test.ts`는 소유 경로상 `lib/llm/medical-boundary.test.ts`에 둠 |

## 트랙 CUSTOMER (2026-10-24, `feat/track-customer`)

| # | 영역 | 스펙 | 구현 | 이유 / 다음 할 일 |
| --- | --- | --- | --- | --- |
| C1 | 다음 회차 | 06: `date + intervalDays`. 10 T08: "3회차 이후 +90일" | 30의 배수 간격은 달력 월로 더한다(30=1개월, 90=3개월, 300=10개월). 그 외(14, 28일)는 일수. 월말은 말일로 맞춘다(01-31 + 1개월 = 02-28). 리셋은 `maintenanceIntervalDays.max x 1.5`, 유지 주기가 없는 시리즈 시술은 `initial.intervalDays x 1.5` | 이 문서 13행 결정(달력 월). 리쥬란 11-14 → 12-14는 두 규칙이 같고, 3회차 이후는 +90일 대신 +3개월(예: 01-14 → 04-14) |
| C2 | 시술 id | 03, 07은 `rejuran_healer` 같은 제품 단위 id | ~~마스터 id(`rejuran`)로 저장~~ 라운드4 머지에서 main의 id 통일(스펙 id `rejuran_healer`, `thermage_flx`, `shrink_universe`, `skin_booster_juvelook`, `botox_forehead`)을 따른다. `lib/agents/customer/procedures.ts`의 별칭은 반대 방향(옛 짧은 id → 스펙 id)으로 남겨 옛 기록도 같은 시리즈로 묶는다 | 옛 id로 저장된 기록이 없어지면 별칭 표를 지운다 |
| C3 | 자동 기록 | 02: 예약으로 받은 시술은 자동 기록 | 예약 확정 때가 아니라 D0 결과 제출 때 `source: "booking"` 기록을 만든다(실결제·실용량이 그때 정해짐). 확정 때는 D0 초안(`OutcomeDraft`)과 받은편지함 알림만 | 시술 전에는 기록이 아니라 예약이라서 |
| C4 | D0 화면 | 05: 실결제, 실용량, 정품 확인, 만족도, 통증, 한 줄 | "다시 갈 의향" 예/아니요를 추가 | `pibu/outcome@1`의 `wouldReturn`이 필수 boolean이라 값을 지어내지 않으려고 |
| C5 | 결과 공유 | 02: 고객이 확인하면 전송 | `shareAnonymizedRecords` 동의가 꺼져 있으면 기록은 남기고 플랫폼에는 보내지 않는다. 체크인 태스크(`customer.checkin`)는 REJECTED로 끝낸다 | 08 5절 |
| C6 | 계정 | 06 `CustomerAccount` | 로그인 계정은 `getSessionUser().customerAgentId`로 프로필을 찾는다. 로그아웃 상태는 `DEMO_MODE=true`일 때만 Yuki(`cus_yuki_done`), 쿠키 `pibu_demo_customer`로 데모 인물 전환. 데모 인물(Yuki, Lin, Emily, 지수)은 처음 조회할 때 `customer` 네임스페이스에 넣는다 | 시드 로더가 고객 네임스페이스를 몰라도 화면이 돈다. 데모에서 [전체 삭제] 뒤 다시 들어오면 데모 인물이 다시 생긴다 |
| C7 | 단독 검증 | 다른 트랙(A2A 코어, 플랫폼, 병원) 없이 화면 검증 | `PIBU_CUSTOMER_MOCK_A2A=true`이면 BFF가 07 기준값(서울글로우 fair, 민트 underdosed, 아라 fair + 실결제 상승)을 돌려주는 프로세스 내 목(`lib/agents/customer/mock-a2a.ts`)을 쓴다. 테스트도 같은 목을 쓴다 | 합친 뒤에는 이 변수를 켜지 않는다 |
| C8 | 의도 파악 | LLM 트랙 `POST /api/intent` | 화면은 `POST /api/customer/intent`를 부르고, BFF가 같은 출처의 `/api/intent`에 `{ message, text, locale }`을 보낸다. 응답에서 `procedureId`가 있는 객체(`request`, `draft`, `procedureRequest`, `condition`, `data`, `toolCalls[].input` 또는 본문)를 찾고, 없거나 실패하면 시술 이름 매칭으로 대신한다. 용량이 없으면 고객 에이전트가 `platform.recipe`로 채운다 | 브라우저 콘솔에 404가 남지 않게 서버에서 대체 |
| C9 | 데모 확정 버튼 | 10 T10: `POST /api/demo/confirm-booking` (OPS) | 예약 화면의 데모 버튼은 `{ clinicId, taskId, bookingId }`로 이 경로를 부른다. 없으면 안내 문장만 | 본문 모양은 OPS 트랙과 맞춰야 함 |
| C10 | 고객 네임스페이스 | 06 엔티티 목록 | 컬렉션: `accounts`, `profiles`, `consents`(추가만, 최신 항목이 유효), `records`, `requests`, `shortlists`(요청별 후보·추천 토큰·응답 실패), `quotes`(id = `요청id:견적id`), `bookings`(고객 쪽 id `cbk_...`, 병원 `bookingId`는 `booking.bookingId`), `outcomes`(`od_<예약>_<D0·D7·D30>`), `inbox` | 다른 트랙은 이 네임스페이스를 읽지 않는다 |
| C11 | 라운드4 머지 | main의 기록 메모·월 단위 날짜·ZK 출처 표시·지갑 | 고객 네임스페이스 기록에 `datePrecision`(StoredRecord)을 더했고, `note`·`anchor`는 06 타입 그대로 쓴다. D0 결과 제출 때 ZK 지갑이 있는 데모 인물이면 기록에 `anchor`(D0_ANCHOR 데모 값, 버전 +1)를 붙인다(`lib/agents/customer/anchor.ts`). `GET /api/customer/me`의 `wallet`, 내보내기의 `wallet`. 리뷰 집계(`verifiedVisits`, `reviewStats`)와 `offerApplied`는 쇼트리스트·견적에서 그대로 화면으로 | 릴레이어(platform.anchor_record)가 붙으면 데모 값 대신 실제 tx를 저장 |

## A2A 로직 이식 (`goranyseoul/a2a-core` → main, 2026-10-24 저녁, `goranyseoul/a2a-logic`)

오너 지시(2026-10-24 16:40~17:00 KST): PR #31을 그대로 머지하면 main 화면·인증·DB가 깨지므로(충돌 70곳), "현존하는 UI나 플로우 화면에는 지장 없는 수준에서" "에이전트끼리 대화 로직(A2A)만" main 구조(SkillHandler + 저장소 어댑터)에 옮긴다. 제출 뒤 "고객 쪽도 작업하고 새 브랜치에서 main에 안전하게 머지". 화면 파일은 건드리지 않았다. 원본 기록은 a2a-core의 BUILD-LOG 18~26행.

| # | 항목 | 스펙 근거 | 이식 내용 | 비고 |
| --- | --- | --- | --- | --- |
| P1 | 매칭 (오너 결정 3) | 07 2절, 03 shortlist, BUILD-LOG 12 | 하드 필터는 검증 상태·메뉴·언어 3개. 지역 하드 필터 삭제, 적합도 0.35는 언어 점수만(staff 1.0, interpreter 0.6), 요청 지역은 reasons 문장("Near where you stay")과 `priceReference` 지역에만 쓴다. `prefer_area`는 가산만. `MAX_CANDIDATES` 5 → 3. 후보마다 `verifiedVisits`와 `reviewStats { n, avgRating }`(n ≥ 3일 때만), 점수에는 불포함 (`lib/agents/platform/matching.ts` `displayStats`) | 트랙 A2A A12를 대체. 유키: 서울글로우 0.79, 민트 0.59, 아라 0.59 (규칙 전 0.7946 · 0.5930 · 0.5928). reasons 4개 언어 문구(a2a-core `matching-copy.ts`)는 화면이 reasons를 안 그려서 이식하지 않음 |
| P2 | 한빛의원 언어 시드 | 01 한빛 = 중국어 병원, 07 56행, 10 데모 3행 | `data/seed/clinics.json` 한빛 `registry.languages`·`profile.languages`에서 `ja staff` 삭제. 지역 필터가 빠지면 한빛이 언어로 걸러져야 유키 후보가 서울글로우·민트·아라가 된다 | 화면 정적 데이터 `lib/ui-data/directory.ts` 205행과 `lib/ui-data/customer.ts` 310행 부근은 아직 한빛 일본어. 화면을 건드리지 않는 범위라 그대로 둠 |
| P3 | 검증 방문·후기 시드 | 06 시드 표 ZK 행, 08 후기 공개 (오너 결정 2) | `data/seed/verified-visits.json`(a2a-core 그대로), `SEED_COLLECTIONS.platform`에 `verified_visits`·`review_stats`·`anchor_logs`, `platformStore` 접근자와 `statKey` | |
| P4 | 병원 견적 ZK 오퍼 증명 (T18 병원 쪽) | INTEGRATION 3절, 03 zk-offer-proof 확장·`offerApplied` | `clinic.quote`가 추천 토큰 검증 직후, LLM 전에 증명을 검증한다 (`lib/agents/clinic/offer-proof.ts`). 키는 스펙 `metadata.offerProof`를 먼저, main 고객 에이전트가 쓰던 `metadata.zkOfferProof`도 받는다. 증명 전용 이벤트(`zkClauses`)만 막고 일반 이벤트는 모두에게 적용. 검증 실패·ZK 꺼짐·시간초과(기본 15초, `ZK_TIMEOUT_MS`)는 조용히 정가. 미앵커 가명은 빈 차트가 만족하는 조건(첫 방문)만 통과. 병원 카드에 확장 선언(`required: false`, chainId 84532, registry 0xcf47…8857) | 검증은 `lib/zk/client.ts` `verifyOffer`를 직접 부른다 (bridge는 `unanchored` 응답을 버림) |
| P5 | 민트 첫 방문 이벤트 시드 | 06 시드 표, 10 데모 4행 | `offer_mint_1` → `ofr_mint_rejuran_first_visit`(GlowPass `glowpass/catalog.mjs`가 증명하는 id) + `zkClauses: [{ clinicId: "cln_mint", maxCount: 0 }]` | ZK 서버가 없는 환경의 가격은 P12. 병원 폴백 픽스처 `lib/agents/clinic/fixtures.ts`의 민트 이벤트는 테스트가 일반 이벤트로 쓰고 있어 그대로 둠 (부트 시드가 돌지 않았을 때만 쓰임) |
| P6 | 증명 조건 보존 | 05 병원 이벤트 시트 증명 조건 프리셋 | `clinic.offers` 응답의 event에 `zkClauses`, 콘솔 `saveOffer`가 이벤트 시트의 `zkClauses`를 저장(스키마 검증)하고 필드 없는 수정은 기존 조건 유지, `offerView`가 `zkClauses`를 돌려준다 | 이전에는 콘솔에서 이벤트를 수정하면 증명 조건이 사라졌다 |
| P7 | 빈 ZK 환경 변수 | 09 env | `lib/zk/client.ts` `toOfferProof`: 빈 `ZK_REGISTRY_ADDRESS`·`ZK_CHAIN_ID`는 미설정으로 본다 (a2a-core dd53a05) | |
| P8 | 플랫폼 ZK 스킬 (T18 플랫폼 쪽) | INTEGRATION, 03, 07 검증 방문과 후기 집계 | `lib/agents/platform/zk-skills.ts`: `platform.anchor_record`(예약 소유·완료·시술 일치 확인 → relayer `anchorVisit` → AnchorLog `anc_<bookingId>`, 검증 방문 +1, 텍스트 `anchored <tx>`), `platform.submit_review`(쓴 nullifier는 ZK 호출 전에 거절 → Semaphore 검증 → n·평균(소수 1자리)·nullifier·원문과 언어 저장). ZK 꺼짐은 FAILED, 잘못된 증명·중복은 REJECTED. 카드에 두 스킬, `match_clinics` 설명은 "up to three" | recordHash는 재계산하지 않는다(P0에서 ZK 서버가 nonce를 만들어 고객이 맞는 해시를 보낼 수 없음, a2a-core와 같음). ZK 호출에 시간제한을 두지 않는다(체인에 남고 로그가 없는 이중 앵커 방지, 재시도는 `already_anchored`). 카드 설명의 "No public feed."는 오너 결정 2와 충돌해 뺐다 (03 예시는 아직 그 문장) |
| P9 | 고객 D0 앵커 (T18 고객 쪽) | INTEGRATION 2절, 10 데모 6행, 트랙 CUSTOMER C11 | D0 결과를 공유했고 플랫폼이 받았으며 ZK 지갑이 있는 고객이면 `platform.anchor_record`를 보낸다 (`lib/agents/customer/orchestrator.ts`, `anchor.ts`). COMPLETED면 artifact 텍스트 `anchored <tx>`의 tx를 기록 `anchor`에 저장. FAILED·REJECTED·tx 없음·오류·45초 시간초과면 지금까지의 `D0_ANCHOR` 데모 값을 그대로 쓴다 (화면 변화 없음) | `ZK_SERVER_URL`이 없으면 호출하지 않는다 (Vercel). 결과를 다시 제출해도 이미 받은 실제 tx는 유지. 메시지의 증명 필드(record, commitments, recordHash, proof)는 데모 값: 플랫폼이 P8 이유로 앞의 네 필드만 쓴다 |
| P10 | 증명 전달 키 | 03 "오퍼 증명 전달", INTEGRATION 3절 | 고객 에이전트가 증명을 `metadata.zkOfferProof`(맨 번들) 대신 `metadata.offerProof`(`pibu/offer-proof@1`, 병원·chainId·registry 포함)로 보낸다. A2A 클라이언트가 그때 `A2A-Extensions`에 `https://pibu.app/ext/zk-offer-proof/v1`을 넣는다 (`lib/a2a/client.ts` `extensionsFor`, 상수 `EXT_ZK_OFFER_PROOF`) | 병원 카드의 확장 선언 확인은 하지 않는다: 카드가 A2A 클라이언트 안에 캐시되어 오케스트레이터가 볼 수 없다. 지금은 모든 병원 카드가 확장을 선언하고, 증명은 GlowPass `match-offers`가 해당한다고 한 병원에만 간다 |
| P11 | 후기 제출 (02 P0 "후기 제출 (ZK 확장)") | 07 검증 방문과 후기 집계, 08 후기 공개 | `lib/agents/customer/review.ts` `submitVisitReview` + `POST /api/customer/records/[id]/review` (`{ rating 1..5, text? ≤ 300 }`). 본인·병원 확인·앵커된 기록이고 지갑에 해당 병원·시술의 미사용 방문 티켓이 있을 때 `platform.submit_review`. ZK 없음·다운 503 `zk_unavailable`, 중복 409 `already_reviewed`, 티켓 없음 409 `no_visit_ticket` | 화면 연결은 없다 (화면을 건드리지 않는 범위). **스펙 공백:** ZK 서버에 고객이 방문 증명을 받아 가는 엔드포인트가 없고, 플랫폼이 부르는 `/api/reviews`가 실제 증명을 만들고 검증한다. 그래서 고객은 scope·message와 지갑 subject + 기록 id로 만든 고정 nullifier, 자리표시 root·points를 보낸다 |
| P12 | ZK 서버가 없을 때의 증명 전용 이벤트 | 03 "증명이 없거나 검증에 실패하면 정가" | **오너 결정 (2026-10-24 저녁, PR #40 머지 전): "ZK 꺼지면 지금처럼".** `ZK_SERVER_URL`이 없으면(현재 Vercel, `/api/zk/offers` status off) 아무도 증명할 수 없으므로 증명 전용 이벤트를 일반 이벤트처럼 적용한다: 민트 99,000원, `event`는 있고 `zkClauses`·`offerApplied`는 없다 (`selectQuoteItem` `proofsRequired`, `skills.ts`가 `zkEnabled()`를 넘김). ZK 서버가 있으면 스펙대로 증명이 있어야 이벤트가, 없거나 실패하면 정가 | 제출한 데모 사이트의 화면과 가격을 그대로 두려는 결정. 스펙과 다른 점은 ZK가 꺼진 환경 한정 |
