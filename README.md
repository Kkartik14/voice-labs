# Voice Labs

Voice Labs is the simulation and evaluation workspace for voice agents.

It sits above the two execution products:

```text
Voice Labs  →  TVIC runtime  →  Earshot evidence
     scenario / variant          incident / analysis
```

Voice Labs owns scenarios, variants, experiments, runs, evaluators, comparisons,
and promotion into regression coverage. TVIC owns live execution. Earshot owns
privacy-governed immutable evidence and operational analysis.

This workspace is intentionally not a Git repository yet. Research and local
working material live under `local/` and are ignored by the future repository.

## Development status

The first local vertical slice is implemented:

- deterministic scenario runner with seeded repetitions and fake tool calls;
- outcome, guardrail, phrase, tool, and latency evaluators;
- immutable run artifacts with transcript, tool, metrics, and evaluator reasons;
- experiment comparison with baseline deltas and regression filtering;
- local JSON persistence, CLI, HTTP API, and production-built web UI;
- scenario promotion into a local regression set;
- a direct TVIC `voice-runtime` adapter with explicit transcript and audio tiers;
- provider traces that state exactly which runtime and media inputs were exercised;
- fail-closed real-provider execution when the local opt-in flag or credentials are absent.

Start the product locally:

```bash
pnpm install
pnpm dev
```

Open `http://127.0.0.1:4321` for the Vite UI. The API runs at
`http://127.0.0.1:4320`. For a production-style local server, run `pnpm build`
then `pnpm start`.

Useful checks:

```bash
pnpm lint
pnpm test
pnpm build
pnpm lab run
```

To run the TVIC provider tier locally, set `VOICE_LABS_TVIC_ENABLED=1` and
`VOICE_LABS_LOAD_TVIC_ENV=1`. Voice Labs then reads provider credentials from
`TVIC_ROOT/.env` at runtime; it never copies them into this workspace or into
run artifacts. The `tvic` tier uses real LLM/TTS providers with scripted
transcript input. The `audio` tier additionally requires scenario audio fixture
paths and exercises real STT input.
Fixture boundaries use TVIC's explicit commit signal by default; set
`VOICE_LABS_AUDIO_MANUAL_COMMIT=0` to test provider endpointing.

Research and downloaded source snapshots are in ignored `local/`; the synthesis
is [local/research/voice-labs-research.md](local/research/voice-labs-research.md).

## Design rules

- A scenario must be reproducible from a versioned input and environment snapshot.
- A run must preserve the exact TVIC and provider configuration used.
- Every operational claim should link to an Earshot incident digest when available.
- Deterministic assertions and probabilistic/LLM evaluations remain separate.
- The Lab must never become a dependency of TVIC's realtime path or Earshot's evidence contract.
- Real-provider runs are opt-in; local deterministic simulation is the default.
