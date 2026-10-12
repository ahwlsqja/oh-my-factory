# References and read status

Read status:

- **text**: the full text or code was read directly.
- **fetch-summary**: read through a fetch tool that returns a model summary. Quotes from these
  sources still need to be checked against the original before publication.
- **secondary**: known only from another source's summary.

Raw research notes from the design workflows are kept outside this repository.

## Philosophy (priority order)

| # | Source | URL | Status |
|---|---|---|---|
| 1 | Will Larson, "Trying the software factory pattern" | https://lethain.com/software-factory-experiment/ | fetch-summary (GeekNews summary also read). The phrase "task completion ≠ goal achievement" comes from the summary, not the post. |
| 1a | Will Larson, "Migrations" | https://lethain.com/migrations/ | fetch-summary |
| 2 | Anthropic, "The AI-native SDLC playbook" (Claxton et al., 2026-08-21) | https://claude.com/ko/resources/articles/the-ai-native-sdlc-playbook | text (PDF, 54 pp.; loop overview, intent.md example, verifier.md, Stage 6 and bands.yaml read verbatim) |
| 3 | StrongDM, Software Factory (home, principles, techniques, products) | https://factory.strongdm.ai/ | fetch-summary. The "Code must not be written/reviewed by humans" rules come from the home page summary. |
| 3a | strongdm/attractor (spec), strongdm/cxdb | https://github.com/strongdm/attractor | text (spec, code) |
| 4 | Piotr Sarnacki, "I'm sorry, but you still have to think" | https://itsallaboutthebit.com/i-am-sorry-but-you-still-have-to-think/ | fetch-summary |
| 4a | Addy Osmani, "Human judgment doesn't leave the software factory. It relocates." (2026-08-21) | https://addyo.substack.com/p/human-judgment-doesnt-leave-the-software | fetch-summary. The quote "Verification buys you trust…" is unverified. |
| 5 | Tomasz Tunguz, "Thinking in Systems, Shipping in Loops"; "Optimizing Software Factories" | https://tomtunguz.com/thinking-in-systems/ | fetch-summary |
| 5a | DHH Rails World keynote coverage (Pragmatic Engineer) | https://blog.pragmaticengineer.com/the-pulse-ror-creator-sparks-new-death-of-coding-by-hand-debate/ | fetch-summary |
| 5b | Dan Shapiro, "The five levels" | https://www.danshapiro.com/blog/2026/01/the-five-levels-from-spicy-autocomplete-to-the-software-factory/ | fetch-summary |
| 5c | GeekNews topics 34925, 32737 | https://news.hada.io/topic?id=34925 | fetch-summary |

## Tool-layer references

| Source | URL | Status | Used for |
|---|---|---|---|
| addyosmani/factory (MIT) | https://github.com/addyosmani/factory | text (code) | gates line, MISCONFIGURED, prove-test, STOP_IF, run records, handoff |
| addyosmani/factory-demo | https://github.com/addyosmani/factory-demo | text | timing records |
| Vercel, "Building a software factory for AI SDK" | https://vercel.com/blog/building-a-software-factory-for-ai-sdk | fetch-summary | outcome classes |
| Warp cloud factory demo (MIT) | https://github.com/warpdotdev-demos/cloud-factory-demo | text | triage states, judge/write job split |
| openai/symphony SPEC (Apache-2.0) | https://github.com/openai/symphony | text | tracker adapter contract |
| oh-my-claudecode | https://github.com/Yeachan-Heo/oh-my-claudecode | text | plugin layout, loop guards |
| oh-my-codex | https://github.com/Yeachan-Heo/oh-my-codex | text / fetch-summary | loop guards, settings isolation |
| oh-my-openagent (SUL-1.0: concepts only, no code copied) | https://github.com/code-yeongyu/oh-my-openagent | fetch-summary | progress-signature dedupe |
| 12-factor-agents (CC BY-SA) | https://github.com/humanlayer/12-factor-agents | text | human request contract |
| Argo Rollouts, Flagger | https://argoproj.github.io/rollouts/ | fetch-summary | measurement provider contract |
| devcontainers spec and CLI | https://containers.dev/ | fetch-summary | execution environment |
| spec-kitty (MIT), BMAD-METHOD | https://github.com/spec-kitty/spec-kitty | text | decision ledger fields, undecided lint |
| shadow-score-spec (MIT) | https://github.com/DUBSOpenHub/shadow-score-spec | text | sealed-test score |
| Anthropic, "Automating eval design and hillclimbing" | https://claude.dev/blog/automating-eval-design-and-hillclimbing/ | fetch-summary | keep/revert, train/holdout |
| Claude Code docs (sandboxing, settings, headless) | https://code.claude.com/docs | fetch-summary + local `claude --help` | isolation flags |
| Codex CLI (`codex exec --help`) | https://developers.openai.com/codex | local help | ephemeral sessions |

## Methodology

| Topic | Source | Status |
|---|---|---|
| Reusable holdout / Thresholdout | Dwork et al., "The reusable holdout", Science 2015 | secondary |
| Ladder | Blum & Hardt, "The Ladder", ICML 2015, arXiv:1502.04585 | secondary |
| Error bars on evals | Miller, "Adding Error Bars to Evals", arXiv:2411.00640 | secondary |
| Quality attribute scenarios | SEI | secondary |
| Online experiments, guardrail metrics | Kohavi et al., "Trustworthy Online Controlled Experiments" | secondary |
| Reward hacking in agents | METR reports; ImpossibleBench | secondary |
| LLM-as-judge bias, juries | PoLL ("Replacing Judges with Juries"); τ-bench pass^k | secondary |
| Clarifying ambiguous requirements | ClarifyGPT, arXiv:2310.10996 | secondary |

Before public release, every quoted sentence and number in `docs/` must have status **text**.
