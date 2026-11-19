# Mental Models Lab — the options market as in-depth interactive models

> A new terminal workspace (`Mental Models` in the rail) that turns the options
> market into **deterministic, unit-tested mental models**: one in-depth
> interactive model per lecture of the "Quant, Built" 43-part course
> (Sir-Teo/explainer-videos `videos/quant`), built on the platform's doctrine —
> one color language, no new chart dependencies, every number reproducible
> from a seed.

## What it is

Twenty interactive models, each grounded in specific lecture parts (the
citation strip on every panel names them):

| Act | Model | The mental model | Course parts |
| --- | --- | --- | --- |
| I | **The fair game** | P vs Q density fans over horizon — the same market, two beliefs; the √t law | Part 1 ch8–9, Part 4, Part 10 ch4 |
| I | **The book as queues** | resting depth as a 3D surface over (price × time): walls replenish, sweeps eat, the tape prints | Part 2 ch2, Parts 36–38 |
| I | **Margin & liquidation** | the reflection-principle probability surface P(touch) over (leverage × horizon) | Part 2 ch4, Part 41 |
| II | **Monte Carlo engine** | the price as an expectation: seeded path cloud + 1/√n convergence band | Part 10 ch4, Part 15 |
| III | **V(S, τ) — the payoff melting** | the hockey-stick ridge convolved by the heat kernel, σ²τ the only clock | Part 10 ch3–6, Part 9 ch6 |
| III | **Greeks atlas** | Δ Γ Θ 𝒱 ρ vanna volga charm speed as surfaces over (strike × expiry) | Part 10 ch6, Part 11 ch1/4 |
| III | **The tree → the PDE** | CRR N=2…400 sawtooth onto the closed form; the lattice as a surface | Part 9 ch6, Part 10 ch5 |
| III | **The American put** | the free boundary S*(t) exercise region + the early-exercise premium surface | Part 10 ch11/14, Part 8 ch12 |
| III | **The smile from moments** | Gram–Charlier: γ₁ tilts, γ₂ curls — density ⟺ surface (Backus–Foresi–Wu) | Part 12 ch1 |
| III | **The volatility surface** | SVI slices on a term structure, sculpted live, with Gatheral's g(k) butterfly-arbitrage valley, calendar check, Lee bounds, JW view | Part 12 ch2–5 |
| III | **Local volatility** | Dupire's formula in total-variance form — the dynamics the surface implies | Part 12 ch6–8 |
| III | **The variance swap strip** | the 1/K² OTM strip: K_var per expiry, flat σ ⇒ K_var = σ exactly | Part 12 ch9–11 |
| III | **How the surface moves** | PCA eigen-surfaces: level breathing, term twist, skew tilt (Cont–da Fonseca) | Part 12 ch2 |
| III | **The gamma scalper** | the live ledger d(book) = ½ΓS²[(ΔS/S)² − σᵢ²Δt] on the gamma ridge + the path-order shuffle | Part 11 ch2–3, Part 10 ch7 |
| III | **The P&L explain** | the morning waterfall: delta…vanna…unexplained vs the real revaluation | Part 11 ch1 |
| III | **The no-trade corridor** | Whalley–Wilmott cube root of cost; Leland's frequency trade | Part 11 ch8, Part 17 ch13–14 |
| III | **Strategy shapes** | 16 structures as P&L surfaces over (spot, vol) that morph — the bets visible as shape | Part 11 ch5 |
| III | **The exotics zoo** | every kind of option: vanilla/asians/barriers/one-touch/binaries/lookbacks/chooser/forward/cliquet/autocall/perpetual/exchange — priced by seeded MC, paths shown | Part 17, Gatheral ch 9–10, Taleb Part III |
| VI | **Pinning at expiry** | dealer gamma pulls spot to the strike — the distribution with/without the force | Part 11 ch11 |
| VI | **The market maker** | inventory skew vs adverse selection — the 64 → 9 lesson | Part 11 ch9 |

Acts IV–V (P-measure premia, portfolios) and VII (the system) live in the
existing Quant / Forecast / Order Flow labs; this lab is the Q-world.

## The 3D engine

`src/components/terminal/models/surface3d.tsx` — a self-contained canvas
renderer (no WebGL, no chart library): painter's-algorithm quad meshes colored
by height on the shared viridis ramp, 3D polylines (paths, boundaries), scatter
dots (quotes, tape prints), translucent barrier planes. Interaction: drag to
orbit, wheel to zoom, dbl-click/R to reset, arrows from the keyboard — the same
deterministic pixels for the same data.

## The math engines (all pure, all tested — 36 tests)

`src/lib/models/` — 9 modules, 36 unit tests (`models.test.ts`) verifying the
lecture's own reference numbers:

- `bs.ts` — BSM prices to 4 decimals against the textbook value (10.4506),
  put–call parity to machine precision, **twelve Greeks** (Δ Γ Θ 𝒱 ρ vanna
  volga charm speed) each validated against finite differences, implied-vol
  inversion, Bachelier, parity synthetics
- `normal.ts` — A&S 7.1.26 Φ (|err| < 1.5e-7) + Acklam/Halley Φ⁻¹ (reference
  values −0.6745, 1.9600 exact)
- `processes.ts` — seeded GBM fans, antithetic MC, CRR trees (European → BSM;
  **American put 6.09 vs European 5.57 verified on the 2,000-step tree**),
  the free boundary, the N-sawtooth, reflection-principle closed forms with
  drift anchors (ν=0 ⇒ 2Φ(−d); T→∞ ⇒ e^{2νgap/σ²}), and a **Brownian-bridge
  one-touch MC** (exact continuous monitoring — the Broadie–Glasserman–Kou gap
  made visible)
- `volsurface.ts` — raw SVI + surfaces on term structures, **Gatheral's g(k)
  validated against the true Breeden–Litzenberger density** (a steep-wing slice
  with genuinely negative density: g_min = −0.57, BL C''_K = −0.53 at the same
  k), calendar detection, Lee wing moments (β=1 ⇒ p̃ = 1/8), Dupire local vol
  (flat ⇒ σ exactly), the variance-swap strip (flat ⇒ K_var = σ exactly, with
  the e^{rT} compounding), JW parameters, delta-quoted strikes
- `exotics.ts` — the 18-exotic catalog, barrier parity (DI + DO = vanilla),
  Asian < vanilla, lookback > vanilla, **Merton's perpetual put smooth fit
  P(S\*) = K − S\* exact**, Margrabe's exchange option
- `hedging.ts` — the scalper's ledger identity (drift-free: set μ ≠ 0 and it
  still balances), realized > implied ⇒ the scalper collects, the P&L explain
  waterfall closes to < 3%, Whalley–Wilmott cube root (×2 cost ⇒ ×2^{1/3})
- `structures.ts` — 16 structures with entry premium, P&L surfaces, Greeks;
  the box's expiry P&L = exactly the carry PV effect
- `market.ts` — the book toy (walls persist, tape prints), MM inventory skew
  (max inventory capped), pinning (SD shrinks), surface PCA (three factors,
  90 %+ explained, PC2 ↔ term, PC3 ↔ skew)

## Verification

- 36/36 model tests; full suite 263 passed
- `tsc --noEmit` clean; zero new lint errors (remaining 8 are pre-existing on main)
- Browser-verified: rail entry, course-map navigation across acts, model
  switching (BSM → atlas → zoo → fair game), greek switching, exotic switching,
  slider interaction, dock-panel fullscreen expand + Esc restore — zero
  console errors, zero page errors

## PR

`scripts/create-pr-mental-models.sh` — push + open the PR in one command
(`GH_TOKEN=<PAT> bash scripts/create-pr-mental-models.sh`), branch
`feat/options-mental-models`.
