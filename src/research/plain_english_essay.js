'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const RESEARCH_DIR = path.join(ROOT, 'research/djdjdjekekek');
const OUTPUT_HTML = path.join(RESEARCH_DIR, 'plain_english_essay.html');
const OUTPUT_PDF = path.join(RESEARCH_DIR, 'plain_english_essay.pdf');

function readJson(name) {
    return JSON.parse(fs.readFileSync(path.join(RESEARCH_DIR, name), 'utf8'));
}

function number(value, digits = 0) {
    return Number(value).toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
    });
}

function money(value, digits = 0) {
    return `${value < 0 ? '-' : ''}$${number(Math.abs(value), digits)}`;
}

function pct(value, digits = 1) {
    return `${value >= 0 ? '+' : ''}${number(value, digits)}%`;
}

function plainPct(value, digits = 1) {
    return `${number(value, digits)}%`;
}

function pp(value, digits = 1) {
    return `${value >= 0 ? '+' : ''}${number(value, digits)} points`;
}

function isoDate(value) {
    return new Date(value).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC'
    });
}

function renderHtml(analysis, edge) {
    const blind = edge.blindCopyCounterfactual;
    const urgencyChronology = edge.subgroupChronology;
    const format = analysis.performance.formatAudit;
    const atomic = edge.atomicBreadthEdge;
    const breadth = atomic.all;
    const breadthCalibration = atomic.allCalibration;
    const narrow = atomic.belowThreshold;
    const narrowCalibration = atomic.belowThresholdCalibration;
    const breadthChronology = atomic.chronology;
    const heldOut = breadthChronology.heldOutAfterDevelopment;
    const heldOutCalibration = breadthChronology.heldOutCalibration;
    const heldOutCluster = breadthChronology.heldOutDayClusterBootstrap;
    const thresholdNull = atomic.thresholdSelection.marketNullSimulation;
    const breadthPermutation = atomic.compositionControlledPermutation;
    const dayContrast = atomic.dayClusterCalibrationContrast.broadMinusNarrow;
    const controlledModel = atomic.probabilityOffsetModels.sizeAndPeriodControlled;
    const breadthCoefficient = controlledModel.coefficients.find((row) => row.name === 'broadSweep');
    const notionalCoefficient = controlledModel.coefficients.find((row) => row.name === 'logNotionalCentered');
    const rapidValidation = edge.lockedRefinement.candidates.find((row) => row.name === 'burst-60').validation;
    const stressTen = atomic.executionSensitivity.find((row) =>
        row.lagSeconds === 60 && row.slippageCents === 10);
    const heldOutScenarioRoi = (row) => 100 * (
        row.validation.profitUsdc + row.finalTest.profitUsdc
    ) / (
        row.validation.stakeUsdc + row.finalTest.stakeUsdc
    );
    const stressTenHeldOutRoi = heldOutScenarioRoi(stressTen);
    const blindSameSecond = blind.executionSensitivity.find((row) =>
        row.lagSeconds === 0 && row.slippageCents === 0);
    const blindOneSecondOneCent = blind.executionSensitivity.find((row) =>
        row.lagSeconds === 1 && row.slippageCents === 1);
    const blindOneSecondOneHalf = blind.executionSensitivity.find((row) =>
        row.lagSeconds === 1 && row.slippageCents === 1.5);
    const blindOneSecondTwoCent = blind.executionSensitivity.find((row) =>
        row.lagSeconds === 1 && row.slippageCents === 2);
    const breadthOneSecondOneCent = atomic.executionSensitivity.find((row) =>
        row.lagSeconds === 1 && row.slippageCents === 1);
    const breadthOneSecondSeventeenHalf = atomic.executionSensitivity.find((row) =>
        row.lagSeconds === 1 && row.slippageCents === 17.5);
    const breadthOneSecondTwenty = atomic.executionSensitivity.find((row) =>
        row.lagSeconds === 1 && row.slippageCents === 20);
    const blindOneSecondBreakEven = blind.executionBreakEven.find((row) => row.lagSeconds === 1);
    const breadthOneSecondBreakEven = atomic.executionBreakEven.find((row) => row.lagSeconds === 1);
    const atlas = edge.copyParameterAtlas;
    const atlasCells = atlas.scenarioCounts.latencyByAdversePriceBothStrategies
        + atlas.scenarioCounts.feeByAdversePricePerStrategy
        + atlas.scenarioCounts.breadthByAdversePrice
        + atlas.scenarioCounts.breadthByLatency;
    const capacity = edge.historicalTapeCapacity;
    const liveCapacity = edge.liveLiquidityCapacity;
    const closing = edge.closingLineAudit;
    const compact = edge.compactFreshMechanism;
    const alternatives = compact.alternativeMechanisms;
    const totalExecutionCells = atlasCells + capacity.scenarioCount;
    const historicalCapacityCell = (stake, window, proxy = 'allPrints', participation = 100) =>
        capacity.grid.find((row) =>
            row.strategy === 'breadthHeldOut'
            && row.proxy === proxy
            && row.windowSeconds === window
            && row.bufferCents === 1
            && row.participationRatePct === participation
            && row.stakeUsdc === stake
        );
    const liveCapacityCell = (stake) => liveCapacity.summary.find((row) =>
        row.segment === 'all' && row.bufferCents === 1 && row.stakeUsdc === stake
    );
    const capacityTableRows = [25, 100, 1000, 10000, 25000].map((stake) => {
        const live = liveCapacityCell(stake);
        const oneSecond = historicalCapacityCell(stake, 1);
        const sixtySeconds = historicalCapacityCell(stake, 60);
        const aligned = historicalCapacityCell(stake, 60, 'reportedAlignedBuys');
        return `<tr><td>${money(stake)}</td><td class="number">${plainPct(live.fillRatePct, 1)}</td><td class="number">${plainPct(oneSecond.fillRatePct, 1)}</td><td class="number">${plainPct(sixtySeconds.fillRatePct, 1)}</td><td class="number">${plainPct(aligned.fillRatePct, 1)}</td></tr>`;
    }).join('');
    const blindRisk = atlas.risk.blindCopy;
    const breadthRisk = atlas.risk.breadthAll;
    const heldOutRisk = atlas.risk.breadthHeldOut;
    const weakestLeaveOneOut = atlas.risk.leaveOneDisciplineOut.reduce(
        (weakest, row) => row.heldOut.roiPct < weakest.heldOut.roiPct ? row : weakest
    );

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="A detailed, illustrated investigation of a Polymarket trader's atomic liquidity-sweep alpha across broad copy-trading execution parameters.">
<title>Inside the Whale's Alpha: Copying Loses, Atomic Breadth Wins</title>
<style>
    :root {
        --ink: #172026;
        --muted: #66737c;
        --line: #d7dde1;
        --paper: #ffffff;
        --soft: #f4f6f7;
        --red: #b43b32;
        --red-soft: #fff2ef;
        --teal: #087e8b;
        --teal-soft: #edf8f8;
        --blue: #4979a5;
        --gold: #d99a1b;
        --gold-soft: #fff8e8;
    }

    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
        margin: 0;
        color: var(--ink);
        background: var(--paper);
        font-family: Arial, Helvetica, sans-serif;
        font-size: 18px;
        line-height: 1.62;
        letter-spacing: 0;
    }
    a { color: #205f8f; text-decoration-thickness: 1px; text-underline-offset: 3px; }
    a:hover { color: var(--teal); }
    code { font-family: Consolas, 'Liberation Mono', monospace; font-size: 0.9em; }
    .page { width: min(100% - 40px, 980px); margin: 0 auto; }
    .masthead {
        border-top: 8px solid var(--red);
        padding: 56px 0 28px;
        border-bottom: 1px solid var(--line);
    }
    .kicker {
        margin: 0 0 14px;
        color: var(--red);
        font-size: 13px;
        line-height: 1.2;
        font-weight: 800;
        text-transform: uppercase;
    }
    h1, h2, h3 { font-family: Georgia, 'Times New Roman', serif; letter-spacing: 0; }
    h1 {
        max-width: 860px;
        margin: 0;
        font-size: 58px;
        line-height: 1.04;
        font-weight: 700;
    }
    .dek {
        max-width: 780px;
        margin: 22px 0 0;
        color: #3f4b53;
        font-size: 23px;
        line-height: 1.45;
    }
    .dateline { margin: 22px 0 0; color: var(--muted); font-size: 14px; }
    .headline-facts {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 0;
        margin: 34px 0 0;
        border-top: 1px solid var(--line);
        border-bottom: 1px solid var(--line);
    }
    .headline-fact { padding: 20px 24px 18px 0; }
    .headline-fact + .headline-fact { padding-left: 24px; border-left: 1px solid var(--line); }
    .headline-fact strong { display: block; font-size: 31px; line-height: 1.1; }
    .headline-fact span { display: block; margin-top: 7px; color: var(--muted); font-size: 14px; line-height: 1.35; }
    .negative { color: var(--red); }
    .positive { color: var(--teal); }
    .neutral { color: var(--blue); }

    main { padding: 30px 0 72px; }
    .contents {
        margin: 6px 0 48px;
        padding: 20px 0;
        border-bottom: 1px solid var(--line);
        color: var(--muted);
        font-size: 15px;
    }
    .contents a { margin-right: 16px; white-space: nowrap; }
    section { margin: 64px 0 0; }
    h2 { margin: 0 0 18px; font-size: 40px; line-height: 1.12; }
    h3 { margin: 34px 0 10px; font-size: 26px; line-height: 1.2; }
    p { margin: 0 0 18px; }
    .lead { font-size: 22px; line-height: 1.55; }
    .bottom-line {
        margin: 18px 0 38px;
        padding: 22px 26px;
        border-left: 6px solid var(--gold);
        background: var(--gold-soft);
        font-size: 21px;
        line-height: 1.5;
    }
    .bottom-line strong { color: #7d5200; }
    .warning {
        margin: 24px 0;
        padding: 20px 24px;
        border-left: 6px solid var(--red);
        background: var(--red-soft);
    }
    .finding {
        margin: 24px 0;
        padding: 20px 24px;
        border-left: 6px solid var(--teal);
        background: var(--teal-soft);
    }
    .plain-language {
        margin: 24px 0;
        padding: 20px 24px;
        border-top: 1px solid var(--line);
        border-bottom: 1px solid var(--line);
        font-size: 20px;
    }
    .plain-language b { color: var(--teal); }
    .alpha-definition {
        margin: 28px 0;
        padding: 26px 0;
        border-top: 3px solid var(--ink);
        border-bottom: 1px solid var(--ink);
    }
    .alpha-definition .equation {
        margin: 18px 0;
        padding: 18px 20px;
        background: var(--soft);
        font-family: Consolas, 'Liberation Mono', monospace;
        font-size: 17px;
        line-height: 1.6;
        overflow-wrap: anywhere;
    }
    .parameter-summary {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        margin: 26px 0;
        border-top: 1px solid var(--line);
        border-bottom: 1px solid var(--line);
    }
    .parameter-summary div { padding: 16px 14px 14px 0; }
    .parameter-summary div + div { padding-left: 14px; border-left: 1px solid var(--line); }
    .parameter-summary strong { display: block; font-size: 24px; line-height: 1.1; }
    .parameter-summary span { display: block; margin-top: 5px; color: var(--muted); font-size: 13px; line-height: 1.35; }
    ol.steps { margin: 24px 0 28px; padding: 0; counter-reset: method; }
    ol.steps li {
        list-style: none;
        position: relative;
        margin: 0;
        padding: 13px 0 13px 54px;
        border-bottom: 1px solid var(--line);
    }
    ol.steps li::before {
        counter-increment: method;
        content: counter(method);
        position: absolute;
        left: 0;
        top: 12px;
        width: 34px;
        height: 34px;
        border: 2px solid var(--blue);
        border-radius: 50%;
        color: var(--blue);
        font-weight: 800;
        line-height: 30px;
        text-align: center;
    }
    figure { margin: 34px 0 12px; break-inside: avoid; page-break-inside: avoid; }
    figure img { display: block; width: 100%; height: auto; border: 1px solid var(--line); }
    figcaption { margin-top: 10px; color: var(--muted); font-size: 14px; line-height: 1.45; }
    table { width: 100%; border-collapse: collapse; margin: 24px 0 30px; font-size: 16px; }
    th { padding: 11px 10px; border-bottom: 2px solid var(--ink); text-align: left; font-size: 13px; text-transform: uppercase; }
    td { padding: 12px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
    td.number { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .comparison td:first-child { font-weight: 700; }
    .fact-list { margin: 22px 0; padding: 0; }
    .fact-list li { margin: 0 0 11px 22px; padding-left: 5px; }
    .confidence-row {
        display: grid;
        grid-template-columns: 150px 1fr;
        gap: 20px;
        padding: 18px 0;
        border-bottom: 1px solid var(--line);
    }
    .confidence-label { font-size: 13px; font-weight: 800; text-transform: uppercase; }
    .confidence-label.high { color: var(--teal); }
    .confidence-label.medium { color: #9a6500; }
    .confidence-label.unknown { color: var(--red); }
    .two-column { display: grid; grid-template-columns: 1fr 1fr; gap: 34px; }
    .rule {
        margin: 34px 0;
        padding: 26px;
        border: 2px solid var(--ink);
        border-radius: 4px;
    }
    .rule h3 { margin-top: 0; }
    .verdict {
        margin: 40px 0 0;
        padding: 30px;
        border-top: 7px solid var(--ink);
        background: var(--soft);
    }
    .verdict h2 { font-size: 34px; }
    .verdict p:last-child { margin-bottom: 0; }
    .glossary dt { margin-top: 18px; font-weight: 800; }
    .glossary dd { margin: 3px 0 0; color: #3f4b53; }
    .sources { font-size: 15px; color: #3f4b53; }
    .sources li { margin-bottom: 8px; }
    footer { padding: 26px 0 50px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }

    @media (max-width: 700px) {
        body { font-size: 17px; }
        .page { width: min(100% - 28px, 980px); }
        .masthead { padding-top: 36px; }
        h1 { font-size: 42px; }
        .dek { font-size: 20px; }
        .headline-facts { grid-template-columns: 1fr; }
        .headline-fact, .headline-fact + .headline-fact { padding: 16px 0; border-left: 0; }
        .headline-fact + .headline-fact { border-top: 1px solid var(--line); }
        h2 { font-size: 32px; }
        .two-column, .confidence-row, .parameter-summary { grid-template-columns: 1fr; gap: 6px; }
        .parameter-summary div + div { padding-left: 0; border-left: 0; border-top: 1px solid var(--line); }
        .contents a { display: inline-block; margin-bottom: 8px; }
        table { font-size: 14px; }
        th, td { padding-left: 7px; padding-right: 7px; }
    }

    @media print {
        @page { size: A4; margin: 14mm 13mm 15mm; }
        body { font-size: 11pt; line-height: 1.48; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
        p, li { orphans: 3; widows: 3; }
        h2, h3 { break-after: avoid; page-break-after: avoid; }
        .page { width: 100%; }
        .masthead { padding: 18mm 0 8mm; }
        h1 { font-size: 39pt; }
        .dek { font-size: 16pt; }
        h2 { font-size: 25pt; }
        h3 { font-size: 17pt; }
        main { padding-top: 6mm; }
        section { margin-top: 14mm; }
        .contents { display: none; }
        .headline-fact strong { font-size: 22pt; }
        .bottom-line, .warning, .finding, .plain-language, .alpha-definition, .parameter-summary, .verdict { break-inside: avoid; page-break-inside: avoid; }
        .rule { break-inside: auto; page-break-inside: auto; }
        .rule .steps li { break-inside: avoid; page-break-inside: avoid; }
        figure img { max-height: 178mm; object-fit: contain; }
        a { color: inherit; }
        .sources { font-size: 9pt; line-height: 1.32; }
        .sources h2 { font-size: 22pt; }
        .sources p { margin-bottom: 5px; }
        .sources ul { margin-top: 5px; margin-bottom: 8px; }
        .sources li { margin-bottom: 0; }
        footer { padding-top: 12px; padding-bottom: 0; font-size: 8pt; }
    }
</style>
</head>
<body>
<header class="masthead">
    <div class="page">
        <p class="kicker">Plain-English alpha and execution dossier</p>
        <h1>Inside the whale's alpha: copying loses, atomic breadth wins.</h1>
        <p class="dek">A transaction-level investigation, ${number(totalExecutionCells)} execution-and-capacity scenarios, and the closest public fingerprint of the trader's hidden decision process that the evidence can support.</p>
        <p class="dateline">Public-data study covering ${isoDate(analysis.coverage.firstTrade)} to ${isoDate(analysis.coverage.lastTrade)}. Analysis generated ${isoDate(edge.generatedAt)}.</p>
        <div class="headline-facts" aria-label="Headline findings">
            <div class="headline-fact"><strong class="negative">${pct(blind.all.roiPct, 2)}</strong><span>return from blindly copying all ${number(blind.all.bets)} large signals</span></div>
            <div class="headline-fact"><strong class="positive">${pct(breadth.roiPct, 2)}</strong><span>return when one trigger matched at least 18 maker accounts</span></div>
            <div class="headline-fact"><strong class="neutral">${pct(heldOut.roiPct, 2)}</strong><span>return from those signals after the threshold was selected</span></div>
        </div>
    </div>
</header>

<main class="page">
    <nav class="contents" aria-label="Essay contents">
        <a href="#answer">The answer</a>
        <a href="#copying">Blind copying</a>
        <a href="#parameter-atlas">Parameter atlas</a>
        <a href="#capacity">Size and fills</a>
        <a href="#chain">Inside the trade</a>
        <a href="#discovery">The discovery</a>
        <a href="#speed">Copy speed</a>
        <a href="#alpha">His alpha</a>
        <a href="#mechanism">The mechanism</a>
        <a href="#closing">Closing line</a>
        <a href="#algorithm">The rule</a>
        <a href="#tests">Stress tests</a>
        <a href="#risk">Risk</a>
        <a href="#verdict">Verdict</a>
    </nav>

    <section id="answer">
        <h2>The answer in thirty seconds</h2>
        <p class="lead">His observable edge is <strong>selective, informed-looking liquidity consumption</strong>. The strongest trades are broad, compact, and fresh: one mined BUY consumes offers from many makers, stays within only a few price levels, and takes recently signed liquidity.</p>
        <div class="bottom-line"><strong>Bottom line:</strong> at least <strong>18 distinct maker accounts</strong> is the frozen first-stage signal: 23 wins from 30 and ${pct(breadth.roiPct, 1)} after the original stress, versus ${pct(narrow.roiPct, 1)} below 18. The closest second-stage mechanism is <strong>18+ makers, no more than three price levels, and median maker age no more than five minutes</strong>: it went 6/7 and returned ${pct(compact.heldOut.roiPct, 1)} held out. But that seven-trade refinement is post-hoc, and closing prices did not validate the broad signals. The private source of the trader's judgment is not cracked.</div>
        <ol class="steps">
            <li><strong>The headline is misleading.</strong> The wallet made ${money(analysis.performance.realizedPnlUsdc)}, but its top five winners produced ${plainPct(analysis.concentration.top5ContributionPct, 0)} of net profit. Removing those five makes the wallet negative.</li>
            <li><strong>Blind copying is not the edge.</strong> ${number(blind.all.bets)} delayed ${money(100)} copies lost ${money(Math.abs(blind.all.profitUsdc), 2)}. The later sample also lost ${pct(blind.later.roiPct, 2)}.</li>
            <li><strong>The public trade feed hides structure.</strong> We decoded all ${number(edge.coverage.decodedTriggerTransactions)} trigger transactions. Every one was a successful V2 <code>matchOrders</code> call with the target as the BUY taker.</li>
            <li><strong>Breadth separated signal from noise.</strong> Broad sweeps beat the market price by ${pp(breadthCalibration.calibrationGapPctPoints, 1)}; narrower transactions missed it by ${pp(narrowCalibration.calibrationGapPctPoints, 1)}.</li>
            <li><strong>Size changes copyability.</strong> At +1 cent, a current liquid-market snapshot could fully fill ${plainPct(liveCapacityCell(100).fillRatePct, 1)} of ${money(100)} FOK orders but only ${plainPct(liveCapacityCell(25000).fillRatePct, 1)} at ${money(25000)}. One second after the historical broad sweeps, even an optimistic all-print ceiling covered only ${plainPct(historicalCapacityCell(100, 1).fillRatePct, 1)} of ${money(100)} requests.</li>
            <li><strong>The market did not confirm the story before play.</strong> Broad pregame signals had median closing-line value of ${number(closing.breadthPregame.medianClosingLineValueCents, 2)} cents, with only ${number(closing.breadthPregame.positiveClosingLineEvents)} of ${number(closing.breadthPregame.events)} positive.</li>
        </ol>
    </section>

    <figure>
        <img src="figures/blind_copy_funnel.png" alt="Bar chart showing blind copying losing money and filtered strategies improving the result.">
        <figcaption><strong>What blind copying would have done:</strong> the first row is the naive strategy. It loses over the full history and after the fixed date split. Earlier behavioral filters found useful clues, but they did not expose what was inside the triggering blockchain transaction.</figcaption>
    </figure>

    <section id="copying">
        <h2>First, the painful result: copying loses</h2>
        <p>The original registered test was deliberately harsh, but ordinary: it did not give the follower the whale's old price.</p>
        <ol class="steps">
            <li>Wait until the target has crossed <strong>${money(25000)}</strong> of aggressive buying and at least 70% of its net direction points to one outcome.</li>
            <li>Keep only the first signal for each underlying match, so a series and its individual maps cannot be counted as independent ideas.</li>
            <li>Wait <strong>60 seconds</strong>, then use the first unrelated public trade in the following minute as the available price. If none appears, retain the trigger price.</li>
            <li>Make the price five cents worse, include the account-observed fee curve, and place the same <strong>${money(100)}</strong> stake every time.</li>
        </ol>
        <p>The result was ${number(blind.all.wins)} wins and ${number(blind.all.bets - blind.all.wins)} losses, yet ${money(blind.all.profitUsdc, 2)} net profit on ${money(blind.all.stakeUsdc)} of turnover. The maximum historical drawdown was ${money(blind.all.maxDrawdownUsdc, 2)}.</p>
        <div class="warning"><strong>This is what blind faith costs:</strong> even a spectacular trader can be a bad signal to copy. The follower sees the action late, pays a worse price, does not know final position size, and cannot reproduce inventory management, maker fills, exits, or rebates.</div>

        <h3>Why winning more than half the bets was not enough</h3>
        <p>Prediction-market prices already contain a probability. Buying a contract at 60 cents means paying roughly as if it has a 60% chance to win. A strategy can win 58% of its bets and still lose if it repeatedly pays prices that require a higher hit rate.</p>
        <p>Blind copying won ${number(blind.calibration.wins)} times. The public prices implied about ${number(blind.calibration.expectedWinsFromExecutionProxy, 2)} wins. The gap was only ${pp(blind.calibration.calibrationGapPctPoints, 1)}. In ordinary language, the extra wins were neither large enough nor valuable enough to establish a generic &ldquo;copy his big buys&rdquo; edge.</p>
    </section>

    <figure>
        <img src="figures/strategy_equity.png" alt="Chronological cumulative profit chart comparing blind copying with progressively filtered strategies.">
        <figcaption>The red blind-copy line remains underwater. More selective rules improve because they reject most trades. This was the clue that the wallet's value lives in selection, not in its address.</figcaption>
    </figure>

    <section id="speed">
        <h2>What if a copy bot is nearly instant?</h2>
        <p class="lead">Speed helps, but the broad replay finds no sharp 1-second-versus-5-second cliff. The dangerous variable is the price paid after the whale has consumed the available offers.</p>
        <p>The expanded audit crosses <strong>${number(atlas.latenciesSeconds.length)} delays</strong>, from the trigger's own second through five minutes, with <strong>${number(atlas.adversePriceCents.length)} adverse-price assumptions</strong> from zero through 30 cents. That is ${number(atlas.scenarioCounts.latencyByAdversePriceBothStrategies)} latency-by-price results across blind and alpha-filtered copies before the fee and maker-threshold atlases. Every primary cell includes the observed fee curve. At the most optimistic same-second price with no extra adverse movement, blind copying returns only ${pct(blindSameSecond.all.roiPct, 1)}. At one second plus one cent it returns ${pct(blindOneSecondOneCent.all.roiPct, 1)}. At one second plus two cents it is already negative at ${pct(blindOneSecondTwoCent.all.roiPct, 1)}.</p>
        <div class="plain-language"><b>The practical threshold:</b> at one-second latency, blind copying historically breaks even at only about ${number(blindOneSecondBreakEven.allMaxAdverseCents, 2)} cents of additional adverse price. Under one second plus one cent, the breadth-filtered held-out sample returned ${pct(heldOutScenarioRoi(breadthOneSecondOneCent), 1)}. Being fast is not enough if the whale just removed the cheap liquidity; selecting the right trigger matters more.</div>
        <p>The timestamps impose an important limit. Polygon block timestamps and the historical public tape are recorded to whole seconds. A 0.1-second bot and a 0.5-second bot cannot be separated honestly. The same-second scenario may also include unrelated prints whose exact within-second order is unknown, so it is an optimistic lower bound rather than a reproducible fill.</p>
        <p>Polymarket's official lifecycle separates an off-chain <code>MATCHED</code> state from <code>MINED</code> on-chain settlement. This strategy needs the mined <code>matchOrders</code> calldata to count maker addresses, so its clock starts at the block timestamp. A bot with private or earlier CLOB-match information is testing a different signal and is not represented by this public-wallet replay.</p>
    </section>

    <figure>
        <img src="figures/copy_execution_surface.png" alt="Two heatmaps showing representative copy-trading returns across latency and adverse-price scenarios for blind copying and the breadth rule.">
        <figcaption><strong>Read across for execution quality; read down for speed.</strong> Blind copying flips from pale green to red at roughly two cents in almost every sub-minute row. The held-out breadth strategy remains green much farther across. A 0.1-second or 0.5-second bot lies between the first two rows because the source timestamps are only one second precise.</figcaption>
    </figure>

    <figure>
        <img src="figures/copy_break_even_frontier.png" alt="Two line charts showing the maximum adverse price compatible with break-even returns at each copy delay.">
        <figcaption>The blind copier has roughly ${number(blindOneSecondBreakEven.allMaxAdverseCents, 1)} cents of room at one second. The 18-maker filter has roughly ${number(breadthOneSecondBreakEven.heldOutMaxAdverseCents, 1)} cents in the held-out half. The near-flat lines mean this dataset does not support a claim that sub-five-second speed is the main edge.</figcaption>
    </figure>

    <section id="parameter-atlas">
        <h2>The full copy-trading parameter atlas</h2>
        <p class="lead">A backtest should show the whole neighborhood, not one convenient assumption. This atlas varies delay, price deterioration, fees, and the maker-breadth cutoff while keeping equal stakes and event deduplication fixed.</p>
        <div class="parameter-summary">
            <div><strong>${number(atlas.latenciesSeconds.length)}</strong><span>delays from same-second through 300 seconds</span></div>
            <div><strong>${number(atlas.adversePriceCents.length)}</strong><span>adverse-price assumptions from 0c through 30c</span></div>
            <div><strong>${number(atlas.feeRatesPct.length)}</strong><span>fee-curve rates from 0% through 5%</span></div>
            <div><strong>26</strong><span>maker-breadth cutoffs from 5 through 30</span></div>
        </div>
        <table class="comparison">
            <thead><tr><th>One-second scenario</th><th class="number">Blind copy</th><th class="number">18-maker held out</th></tr></thead>
            <tbody>
                <tr><td>No extra adverse price</td><td class="number positive">${pct(blind.executionSensitivity.find((row) => row.lagSeconds === 1 && row.slippageCents === 0).all.roiPct, 1)}</td><td class="number positive">${pct(heldOutScenarioRoi(atomic.executionSensitivity.find((row) => row.lagSeconds === 1 && row.slippageCents === 0)), 1)}</td></tr>
                <tr><td>One cent worse</td><td class="number positive">${pct(blindOneSecondOneCent.all.roiPct, 1)}</td><td class="number positive">${pct(heldOutScenarioRoi(breadthOneSecondOneCent), 1)}</td></tr>
                <tr><td>1.5 cents worse</td><td class="number">${pct(blindOneSecondOneHalf.all.roiPct, 1)}</td><td class="number positive">${pct(heldOutScenarioRoi(atomic.executionSensitivity.find((row) => row.lagSeconds === 1 && row.slippageCents === 1.5)), 1)}</td></tr>
                <tr><td>Two cents worse</td><td class="number negative">${pct(blindOneSecondTwoCent.all.roiPct, 1)}</td><td class="number positive">${pct(heldOutScenarioRoi(atomic.executionSensitivity.find((row) => row.lagSeconds === 1 && row.slippageCents === 2)), 1)}</td></tr>
                <tr><td>17.5 cents worse</td><td class="number negative">${pct(blind.executionSensitivity.find((row) => row.lagSeconds === 1 && row.slippageCents === 17.5).all.roiPct, 1)}</td><td class="number positive">${pct(heldOutScenarioRoi(breadthOneSecondSeventeenHalf), 1)}</td></tr>
                <tr><td>Twenty cents worse</td><td class="number negative">${pct(blind.executionSensitivity.find((row) => row.lagSeconds === 1 && row.slippageCents === 20).all.roiPct, 1)}</td><td class="number negative">${pct(heldOutScenarioRoi(breadthOneSecondTwenty), 1)}</td></tr>
            </tbody>
        </table>
        <div class="finding"><strong>What the spectrum says:</strong> blind copying is a thin-margin trade that flips near 1.5 to 2 cents. The held-out alpha filter does not flip until roughly 19 to 20 cents. The major difference comes from selecting the transaction, not shaving a few seconds from the bot.</div>
    </section>

    <figure>
        <img src="figures/copy_latency_curves.png" alt="Line atlas showing blind-copy and breadth-filtered ROI at fifteen delays for seven execution-cost levels.">
        <figcaption><strong>All fifteen measured delays:</strong> each line holds the adverse price constant. The lines barely move through the sub-minute region, while moving between price-cost lines changes the answer immediately.</figcaption>
    </figure>

    <figure>
        <img src="figures/copy_cost_curves.png" alt="Line atlas showing ROI across seventeen adverse-price assumptions at representative copy delays.">
        <figcaption><strong>All seventeen cost assumptions:</strong> blind-copy curves cross zero near two cents regardless of delay. The held-out breadth curves cross near twenty cents.</figcaption>
    </figure>

    <figure>
        <img src="figures/fee_cost_surface.png" alt="Heatmaps showing ROI across six fee rates and seventeen adverse-price assumptions for blind and breadth-filtered copying.">
        <figcaption>Fees shift the result gradually. Paying through the book shifts it much faster. The primary replay uses the account-observed 3% fee curve; every other fee row is a labeled counterfactual.</figcaption>
    </figure>

    <figure>
        <img src="figures/execution_print_coverage.png" alt="Line chart showing public execution-proxy coverage at each latency for blind and breadth-filtered signals.">
        <figcaption>Fast scenarios still have roughly 99% public-print coverage. Missing prints are kept with a fallback instead of being dropped, but a public print still does not prove historical ask depth or queue position.</figcaption>
    </figure>

    <section id="capacity">
        <h2>The missing dimension: can the copy actually fit?</h2>
        <p class="lead">A backtest that changes price but assumes every requested dollar fills is incomplete. Size determines whether an FOK order trades at all, and the whale has usually consumed the most obvious liquidity before a public follower can react.</p>
        <p>We added <strong>${number(capacity.scenarioCount)} capacity cells</strong> on top of the ${number(atlasCells)}-cell parameter atlas: five accumulation windows, four price buffers, four participation limits, ten requested stake sizes, two turnover proxies, and three strategy samples. Together the report now evaluates <strong>${number(totalExecutionCells)} execution-and-capacity scenarios</strong>.</p>
        <div class="parameter-summary">
            <div><strong>${number(liveCapacity.coverage.eligibleTokenSides)}</strong><span>current token-side books in the liquid sports sample</span></div>
            <div><strong>${number(capacity.breadthHeldOutEvents.length)}</strong><span>historical held-out breadth signals</span></div>
            <div><strong>${money(liveCapacityCell(100).availableNotionalUsdc.median, 0)}</strong><span>median displayed depth through +1c today</span></div>
            <div><strong>${number(capacity.scenarioCount)}</strong><span>stake, speed, buffer, proxy, and participation cells</span></div>
        </div>
        <table class="comparison">
            <thead><tr><th>Requested stake at +1c</th><th class="number">Current immediate FOK</th><th class="number">Post-sweep 1s all prints</th><th class="number">Post-sweep 60s all prints</th><th class="number">Post-sweep 60s aligned BUYs</th></tr></thead>
            <tbody>${capacityTableRows}</tbody>
        </table>
        <div class="warning"><strong>Do not merge these columns into one promise.</strong> Current FOK is executable displayed depth, but it was sampled now from high-volume moneylines and not after this whale traded. Historical columns are cumulative public turnover after the signal, not simultaneous asks. The all-print column is deliberately optimistic because it treats direction-neutral prints as replaceable capacity.</div>
    </section>

    <figure>
        <img src="figures/live_fok_capacity_surface.png" alt="Three heatmaps showing immediate FOK fill rates by stake and price buffer in current sports moneyline books.">
        <figcaption><strong>What size does to a real book:</strong> ${money(100)} through +1 cent fit in ${plainPct(liveCapacityCell(100).fillRatePct, 1)} of the sampled token sides; ${money(10000)} fit in ${plainPct(liveCapacityCell(10000).fillRatePct, 1)}; ${money(25000)} fit in only ${plainPct(liveCapacityCell(25000).fillRatePct, 1)}. Larger buffers raise fill coverage by authorizing worse prices.</figcaption>
    </figure>

    <figure>
        <img src="figures/live_depth_survival.png" alt="Curves showing current full-fill rates and conditional VWAP slippage by requested FOK size.">
        <figcaption>The left panel contains the main size penalty: rejected orders. The right panel conditions on books that could fill completely, so the modest VWAP numbers cannot be read as proof that large orders are generally easy to execute.</figcaption>
    </figure>

    <figure>
        <img src="figures/capacity_reality_gap.png" alt="Line chart comparing current generic FOK capacity with observed post-sweep historical turnover.">
        <figcaption>The timing problem is visible. Generic liquid books often look deep before anyone trades. Immediately after a broad target sweep, the optimistic turnover ceiling is far lower because the first mover has already removed supply.</figcaption>
    </figure>

    <section>
        <h2>A realistic size projection is mostly a rejection projection</h2>
        <p>For the 21 held-out breadth signals, a ${money(100)} request at +1 cent found enough <em>total observed prints</em> within one second only ${plainPct(historicalCapacityCell(100, 1).fillRatePct, 1)} of the time. Waiting 60 seconds raised that optimistic ceiling to ${plainPct(historicalCapacityCell(100, 60).fillRatePct, 1)}. Restricting participation to 25% cut the 60-second figure to ${plainPct(historicalCapacityCell(100, 60, 'allPrints', 25).fillRatePct, 1)}. Using only reported aligned BUYs produced ${plainPct(historicalCapacityCell(100, 60, 'reportedAlignedBuys').fillRatePct, 1)}.</p>
        <p>At ${money(1000)}, the one-second all-print ceiling covered ${plainPct(historicalCapacityCell(1000, 1).fillRatePct, 1)} of held-out signals. At ${money(10000)}, it covered ${plainPct(historicalCapacityCell(10000, 1).fillRatePct, 1)}. Those numbers do not say the remaining trades partially filled: an FOK instruction rejects the whole order when displayed depth is short.</p>
        <div class="plain-language"><b>Practical paper rule:</b> calculate the ordinary risk cap, then reduce it to at most 10% of displayed ask notional through the one-cent limit. Reject the signal below ${money(25)}. Walk every eligible ask level to estimate VWAP, submit no order in this repository, and record would-fill versus would-reject. This avoids pretending a ${money(100)} strategy scales linearly to ${money(10000)}.</div>
    </section>

    <figure>
        <img src="figures/historical_capacity_surface.png" alt="Heatmaps showing post-sweep turnover coverage across stake, speed, participation, and public-print proxies.">
        <figcaption>Capacity disappears fastest at large stake and short delay. The middle panel limits the hypothetical follower to 25% of observed turnover. The right panel uses the narrower reported-side proxy. None is a reconstructed historical book.</figcaption>
    </figure>

    <figure>
        <img src="figures/historical_size_projection.png" alt="Curves showing historical capacity coverage and retrospective outcome-weighted returns by requested stake.">
        <figcaption>The outcome-weighted panel is intentionally labeled as retrospective: capacity selects which known events remain in the sample. It is useful for diagnosing scale and selection effects, not for forecasting profit.</figcaption>
    </figure>

    <section id="chain">
        <h2>The breakthrough came from looking inside the trade</h2>
        <p class="lead">A public feed row says the whale bought one outcome. Polygon calldata says exactly how that buy was assembled.</p>
        <p>Polymarket's V2 exchange accepts one taker order and an array of maker orders in a call named <code>matchOrders</code>. The taker demands immediate execution. Each maker had already signed an offer. One public-looking trade can therefore be an atomic sweep through many counterparties and several prices.</p>
        <div class="plain-language"><b>One public print is not necessarily one simple trade.</b> It can be one urgent order consuming a large section of the order book in the same mined transaction.</div>
        <p>We fetched and decoded every one of the ${number(edge.coverage.targetSignals)} trigger hashes. All ${number(edge.coverage.targetAsDecodedTaker)} showed this wallet as the decoded taker buying the signaled token. The typical trigger matched ${number(edge.coverage.medianMakerOrdersPerTrigger)} maker orders from ${number(edge.coverage.medianUniqueMakersPerTrigger)} distinct maker accounts. ${number(edge.coverage.multiPriceLevelTriggers)} triggers crossed more than one price level. The reconstructed notional agreed with the signal to within less than one millionth of one percent.</p>
        <div class="finding"><strong>Why this matters:</strong> the final dollar amount says how much was bought. Maker breadth says how much standing liquidity the trader chose to consume at once. Those are different behaviors.</div>
    </section>

    <figure>
        <img src="figures/atomic_sweep_anatomy.png" alt="Bar chart showing the individual price levels and maker orders consumed by one winning FURIA trigger transaction.">
        <figcaption>An illustrative winning FURIA trigger matched 35 maker orders from 25 distinct signed accounts across four price levels, from 43 to 46 cents. The target consumed about ${money(1005518.93, 2)} of notional; the median resting order was 36 seconds old. This example explains the mechanism. The statistical result uses every eligible event.</figcaption>
    </figure>

    <section id="discovery">
        <h2>The discovery: atomic breadth</h2>
        <p class="lead">The strongest observable fingerprint is simple: <strong>did the triggering transaction match at least 18 distinct maker accounts?</strong></p>
        <p>The comparison starts with the same conservative event universe: first canonical signal only, core tennis, soccer, and esports disciplines, full-event contracts rather than maps or short markets, target concentration of at least 70%, and trigger prices between 30 and 85 cents. That leaves ${number(edge.coverage.baseEligibleEvents)} events. Breadth is the final split.</p>

        <table class="comparison">
            <thead><tr><th>What happened</th><th class="number">18+ makers</th><th class="number">Below 18</th></tr></thead>
            <tbody>
                <tr><td>Number of bets</td><td class="number">${number(breadth.bets)}</td><td class="number">${number(narrow.bets)}</td></tr>
                <tr><td>Wins implied by public prices</td><td class="number">${number(breadthCalibration.expectedWinsFromExecutionProxy, 2)}</td><td class="number">${number(narrowCalibration.expectedWinsFromExecutionProxy, 2)}</td></tr>
                <tr><td>Actual wins</td><td class="number positive">${number(breadth.wins)}</td><td class="number">${number(narrow.wins)}</td></tr>
                <tr><td>Price-implied win rate</td><td class="number">${plainPct(breadthCalibration.meanImpliedProbabilityPct, 1)}</td><td class="number">${plainPct(narrowCalibration.meanImpliedProbabilityPct, 1)}</td></tr>
                <tr><td>Actual win rate</td><td class="number positive">${plainPct(breadth.winRatePct, 1)}</td><td class="number">${plainPct(narrow.winRatePct, 1)}</td></tr>
                <tr><td>Gap versus price</td><td class="number positive">${pp(breadthCalibration.calibrationGapPctPoints, 1)}</td><td class="number negative">${pp(narrowCalibration.calibrationGapPctPoints, 1)}</td></tr>
                <tr><td>Equal-stake return after costs</td><td class="number positive">${pct(breadth.roiPct, 2)}</td><td class="number negative">${pct(narrow.roiPct, 2)}</td></tr>
            </tbody>
        </table>
        <p>At a ${money(100)} equal stake, the 30 broad sweeps made ${money(breadth.profitUsdc, 2)}. Even after removing the five most profitable winners, the remaining return was ${pct(breadth.roiWithoutTopWinnersPct['5'], 1)}. The narrower group lost ${money(Math.abs(narrow.profitUsdc), 2)}.</p>
        <div class="finding"><strong>The market-price test:</strong> public prices expected about ${number(breadthCalibration.expectedWinsFromExecutionProxy, 2)} wins; 23 occurred. The one-sided Poisson-binomial probability of at least that many wins under those market probabilities is <strong>${plainPct(breadthCalibration.poissonBinomialUpperTailPValue * 100, 2)}</strong>. The same calculation finds no edge below 18 makers.</div>
    </section>

    <figure>
        <img src="figures/atomic_breadth_calibration.png" alt="Bar chart comparing price-implied and actual win rates for broad and narrow trigger transactions.">
        <figcaption>Public prices expected similar difficulty after filtering. Broad atomic sweeps won far more often than their prices implied; narrower triggers landed almost exactly where the market predicted.</figcaption>
    </figure>

    <figure>
        <img src="figures/maker_breadth_distribution.png" alt="Two charts showing wins, losses, actual win rates, and market-implied probabilities across maker-breadth bands.">
        <figcaption>The 18-maker rule sits inside a graded transaction pattern. Outcomes begin separating from public probabilities around the broad-sweep region; stricter bins eventually become too small to trust.</figcaption>
    </figure>

    <figure>
        <img src="figures/breadth_notional_scatter.png" alt="Scatter plot comparing trigger notional with distinct maker breadth, colored by resolved outcome.">
        <figcaption>Large notional appears above and below the line and among winners and losers. The informative dimension is how broadly one order consumed standing liquidity, not simply how many dollars it represented.</figcaption>
    </figure>

    <section>
        <h2>Did it hold up after discovery?</h2>
        <p>The 18-maker threshold was selected using only the first half of eligible history. Integer cutoffs from 5 through 30 were compared, each requiring at least eight development bets. The next half was then scored without changing the rule.</p>
        <p>The broad-sweep rule returned ${pct(breadthChronology.development.roiPct, 1)} in development, ${pct(breadthChronology.validation.roiPct, 1)} in the next block, and ${pct(breadthChronology.finalTest.roiPct, 1)} in the final block. Combined after selection, 21 signals won 15 times and returned ${pct(heldOut.roiPct, 2)}.</p>
        <div class="finding"><strong>Held-out calibration:</strong> public prices expected ${number(heldOutCalibration.expectedWinsFromExecutionProxy, 2)} wins; 15 occurred. Resampling whole trading days gave a held-out ROI interval from ${pct(heldOutCluster.ci95LowPct, 1)} to ${pct(heldOutCluster.ci95HighPct, 1)}.</div>
    </section>

    <figure>
        <img src="figures/breadth_chronology.png" alt="Three chronological bars showing returns for broad-sweep signals in development, validation, and final-test periods.">
        <figcaption>The middle period was modest, but crucially stayed positive. The final block rebounded without changing the 18-maker rule.</figcaption>
    </figure>

    <figure>
        <img src="figures/breadth_threshold_lock.png" alt="Chart showing development calibration across maker-breadth cutoffs and the held-out result at the selected threshold of 18.">
        <figcaption>The dashed line marks the cutoff chosen on development data. The held-out curve was not used to select 18. Nearby cutoffs tell a similar story, while very strict cutoffs leave too few bets.</figcaption>
    </figure>

    <section id="alpha">
        <h2>His alpha, literally</h2>
        <p class="lead"><strong>The recoverable alpha is a conditional probability error:</strong> public prices understate how often the target's side wins when one eligible BUY transaction consumes liquidity from at least 18 distinct maker accounts.</p>
        <div class="alpha-definition">
            <h3>Observable alpha definition</h3>
            <div class="equation">B(tx) = count(distinct makerOrders[].maker)<br>
Eligible(tx) = first canonical event AND core discipline AND full-event market<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;AND concentration &gt;= 70% AND trigger price in [0.30, 0.85]<br>
Signal(tx) = Eligible(tx) AND target is BUY taker AND B(tx) &gt;= 18<br>
Probability alpha = realized outcome - public execution-proxy probability</div>
            <p><strong>Measured probability alpha:</strong> ${pp(breadthCalibration.calibrationGapPctPoints, 2)} over all 30 broad sweeps and ${pp(heldOutCalibration.calibrationGapPctPoints, 2)} over the 21 signals after development selection. Below 18 makers, the corresponding gap was ${pp(narrowCalibration.calibrationGapPctPoints, 2)}.</p>
            <p><strong>Measured economic alpha:</strong> ${pct(breadth.roiPct, 2)} under the original 60-second plus five-cent stress; ${pct(heldOut.roiPct, 2)} in the post-selection half; ${pct(heldOutScenarioRoi(breadthOneSecondOneCent), 2)} under the realistic one-second plus one-cent scenario.</p>
        </div>
        <div class="plain-language"><b>In ordinary words:</b> most large buys are not special. The special-looking ones are single decisions that clear offers from many signed accounts at once. That is the public footprint of conviction. The private model, information, or judgment that produced the conviction is still hidden.</div>
        <p>This distinction matters. We did not reverse-engineer his sports model or prove private information. We recovered an <strong>observable gating variable</strong> that identifies when his action historically contained information beyond the market price. That is the most literal alpha statement public evidence supports.</p>
    </section>

    <section id="mechanism">
        <h2>The closest answer to “what is his secret?”</h2>
        <p class="lead">Within broad sweeps, the best transactions are <strong>compact and fresh</strong>: many separate makers are consumed, but the order does not chase through a long price ladder, and the typical maker order was signed within five minutes.</p>
        <div class="alpha-definition">
            <h3>Exploratory mechanism fingerprint</h3>
            <div class="equation">Strong(tx) = distinct makers &gt;= 18<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;AND distinct execution price levels &lt;= 3<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;AND median maker-order age &lt;= 300 seconds</div>
            <p>Development selected the three-level and 300-second bounds from the declared grid. It found 5 bets, all winners, at ${pct(compact.development.roiPct, 1)}. The unchanged rule then found 7 held-out bets, 6 winners, at ${pct(compact.heldOut.roiPct, 2)}. Across all history it went ${number(compact.all.wins)}/${number(compact.all.bets)} at ${pct(compact.all.roiPct, 2)}; the other broad sweeps went ${number(compact.otherBroadSweeps.wins)}/${number(compact.otherBroadSweeps.bets)} at ${pct(compact.otherBroadSweeps.roiPct, 2)}.</p>
        </div>
        <p><strong>Interpretation:</strong> this looks less like reckless price chasing and more like decisive acceptance of dense, recently posted liquidity. The wallet is taking a lot of independent-looking supply while the price ladder remains compact. That geometry is a closer footprint of high conviction than dollar amount, flow speed, or maker count alone.</p>
        <h3>Two attractive explanations failed</h3>
        <ul class="fact-list">
            <li><strong>Not stale-quote harvesting.</strong> Median maker age was ${number(alternatives.staleLiquidity.broadMedianMakerAgeSeconds, 1)} seconds in broad sweeps and ${number(alternatives.staleLiquidity.narrowMedianMakerAgeSeconds, 1)} seconds in narrow ones. More importantly, broad winners consumed maker orders with median age ${number(alternatives.staleLiquidity.broadWinnerMedianMakerAgeSeconds, 1)} seconds, versus ${number(alternatives.staleLiquidity.broadLossMedianMakerAgeSeconds, 1)} seconds for broad losses. Winners were fresher, not staler.</li>
            <li><strong>Not one recurring set of weak counterparties.</strong> The 30 broad signals touched ${number(alternatives.recurringMakerIdentity.uniqueMakersAcrossBroadSignals)} unique maker accounts; ${number(alternatives.recurringMakerIdentity.makersSeenInMultipleBroadSignals)} appeared in multiple broad signals. Winners and losses had similar prior-seen maker shares, ${plainPct(alternatives.recurringMakerIdentity.winnerMedianPriorSeenMakerSharePct, 1)} versus ${plainPct(alternatives.recurringMakerIdentity.lossMedianPriorSeenMakerSharePct, 1)}. Prior target-side outcomes against those makers also failed to separate the groups cleanly.</li>
        </ul>
        <div class="warning"><strong>This is the sharpest lead, not a solved private model.</strong> The compact-fresh family was proposed after inspecting the wallet. A 20,000-draw null that repeated the stated grid gave p=${number(compact.comparisons.selectionCorrectedMarketNull.oneSidedPValue, 4)}, but it cannot correct for every idea considered. The held-out sample contains seven bets, and its day-cluster 95% ROI interval runs from ${pct(compact.heldOutDayClusterBootstrap.ci95LowPct, 1)} to ${pct(compact.heldOutDayClusterBootstrap.ci95HighPct, 1)}.</div>
    </section>

    <figure>
        <img src="figures/compact_fresh_mechanism.png" alt="Charts comparing broad sweeps with the compact-fresh exploratory transaction geometry.">
        <figcaption>The second-stage fingerprint concentrates the result, including in the held-out block, but the sample is too small to promote it into a live strategy. The paper monitor records it as a shadow tag while the frozen 18-maker rule remains the primary gate.</figcaption>
    </figure>

    <section id="closing">
        <h2>The closing line refuses to confirm the secret</h2>
        <p class="lead">A genuinely informed pregame bet should often move toward the trader's side before play. That independent check did not happen here.</p>
        <p>We found a final non-target public print before recorded start for all ${number(closing.allEligiblePregame.events)} eligible pregame events. The median print was only ${number(closing.allEligiblePregame.closingPrintStalenessSeconds.median, 0)} seconds before start. Among the ${number(closing.breadthPregame.events)} broad pregame sweeps, median closing-line value was <strong>${number(closing.breadthPregame.medianClosingLineValueCents, 2)} cents</strong> and mean value was ${number(closing.breadthPregame.meanClosingLineValueCents, 2)} cents. Only ${number(closing.breadthPregame.positiveClosingLineEvents)} of ${number(closing.breadthPregame.events)} closed higher for the target side.</p>
        <p>A one-sided sign test for positive broad-sweep CLV gave p=${number(closing.tests.breadthPositiveClvSignTest.oneSidedPValueForPositiveClv, 3)}. Broad and narrow CLV distributions were not distinguishable either, with two-sided Mann-Whitney p=${number(closing.tests.breadthVsNarrowMannWhitney.twoSidedPValue, 3)}. The broad group still won ${number(closing.breadthPregame.wins)}/${number(closing.breadthPregame.events)}, leaving a ${pp(closing.breadthPregame.closingCalibrationGapPctPoints, 1)} settlement gap even at closing prices, but the market itself did not validate that information before the games began.</p>
        <div class="warning"><strong>This blocks the “arm the wallet” conclusion.</strong> Settlement outcomes look exceptional, but pregame price discovery does not confirm them, the compact-fresh pregame subset contains only ${number(closing.compactFreshBreadthPregame.events)} event, and historical fill capacity is uncertain. A live-money system would be acting on an unresolved contradiction, not a cracked code.</div>
    </section>

    <figure>
        <img src="figures/closing_line_validation.png" alt="Chronological and distribution charts of closing-line value for broad and narrow pregame signals.">
        <figcaption>Broad sweeps won more often at settlement, yet their prices generally did not strengthen before play. This is the report's strongest negative result and the main reason the mechanism remains a prospective paper hypothesis.</figcaption>
    </figure>

    <figure>
        <img src="figures/breadth_threshold_cost_surface.png" alt="Heatmap showing held-out ROI for maker-breadth cutoffs from five through thirty and adverse execution costs from zero through thirty cents.">
        <figcaption><strong>Breadth by cost:</strong> the dark horizontal outline is the frozen 18-maker row. Neighboring cutoffs form a broad profitable region at realistic costs; very strict rows are based on tiny samples and are not alternative strategies.</figcaption>
    </figure>

    <figure>
        <img src="figures/breadth_threshold_latency_surface.png" alt="Heatmap showing held-out ROI for maker-breadth cutoffs and all fifteen measured copy delays at one cent adverse execution.">
        <figcaption><strong>Breadth by latency:</strong> horizontal bands dominate vertical changes. Choosing broad sweeps mattered much more than whether the historical proxy entered at one, five, or sixty seconds.</figcaption>
    </figure>

    <section>
        <h2>Speed was the clue, not the final answer</h2>
        <p>The earlier investigation found &ldquo;conviction compression&rdquo;: at least 80% of observed taker buying arriving in the final minute. Across the full sample, rapid signals returned ${pct(urgencyChronology.all.burst60.roiPct, 1)} while slower signals returned ${pct(urgencyChronology.all.slower.roiPct, 1)}. That was useful, but incomplete.</p>
        <p>The rapid rule lost ${plainPct(Math.abs(rapidValidation.roiPct), 1)} in its middle validation block. Atomic breadth returned ${pct(breadthChronology.validation.roiPct, 1)} in that stage and ${pct(breadthChronology.finalTest.roiPct, 1)} in the final test. Speed pointed toward urgency; calldata revealed the stronger form of urgency.</p>
        <div class="plain-language"><b>Flow speed asks:</b> did the target accumulate quickly? <b>Atomic breadth asks:</b> did one executable decision consume offers from many different signed accounts? The second measure is closer to the act of demanding liquidity now.</div>
    </section>

    <figure>
        <img src="figures/urgency_calibration.png" alt="Bar chart comparing public implied probability with actual win rate for rapid and slow signals.">
        <figcaption>Rapid buying was the first useful behavioral clue. It remains a confidence tag, not a hard requirement, because its own middle validation period lost money.</figcaption>
    </figure>

    <figure>
        <img src="figures/burst_threshold_sensitivity.png" alt="Line and bar chart showing urgency results across several rapid-flow definitions.">
        <figcaption>The urgency clue was not one lucky exact cutoff, but these overlapping thresholds are descriptive rather than independent confirmations.</figcaption>
    </figure>

    <section id="algorithm">
        <h2>The algorithm: atomic-breadth-18, paper only</h2>
        <p class="lead">This is the frozen discovery translated into a capacity-aware prospective monitor. It is ready to observe and emit paper intents; it is intentionally not armed with wallet keys or order submission.</p>
        <div class="rule">
            <h3>Paper-trading specification</h3>
            <ol class="steps">
                <li>Keep only the first signal for the real underlying event in core tennis, soccer, and esports.</li>
                <li>Reject individual maps, single-game fragments, and short-horizon side markets.</li>
                <li>Require the target to be at least 70% concentrated on one outcome and the trigger price to be 30 through 85 cents.</li>
                <li>Decode the mined V2 <code>matchOrders</code> transaction and verify that the target is the BUY taker for the signaled token.</li>
                <li>Count distinct addresses in <code>makerOrders[].maker</code>. Continue only when the count is at least <strong>18</strong>.</li>
                <li>Record whether the sweep also has at most three price levels and median maker age at most 300 seconds. This is a shadow tag, not a production gate, until it has a larger prospective sample.</li>
                <li>At the first observation at least one second after the block timestamp, snapshot every displayed ask level. Historical data cannot honestly distinguish 0.1 from 0.5 seconds.</li>
                <li>Set the ordinary risk cap to the minimum of ${money(100)}, 0.5% of bankroll, and 1% event exposure. Then reduce it again to at most <strong>10% of displayed ask notional</strong> through the price limit. Reject orders below ${money(25)}.</li>
                <li>Walk asks to calculate exact paper VWAP. The FOK limit is at most one cent above best ask, five cents above trigger, and 0.90 absolutely. If the complete size cannot fill, record a rejection rather than a partial fantasy fill.</li>
                <li>Require the frozen model's predicted edge after fee-adjusted VWAP, keep one position per correlated event, cap portfolio exposure at 5%, and hold accepted paper fills to resolution.</li>
            </ol>
        </div>
        <p>The one-cent FOK buffer is a prospective paper convention, not a claim that historical depth existed. The replay's one-second plus one-cent price-only cell returned ${pct(heldOutScenarioRoi(breadthOneSecondOneCent), 1)} in the held-out half, but only ${plainPct(historicalCapacityCell(100, 1).fillRatePct, 1)} had ${money(100)} of optimistic one-second all-print capacity. The original 60-second plus five-cent case remains the registered comparison. No live orders, private keys, approvals, martingale, inferred eventual whale size, discretionary exits, or threshold changes after a bad result are implemented.</p>
        <div class="warning"><strong>Why the repository will not “just arm the wallet”:</strong> the closing-line test is negative, the compact-fresh held-out sample is seven, and post-sweep FOK depth is unknown. Connecting signing and submission now would convert unresolved research risk into unattended financial risk without adding evidence.</div>
    </section>

    <section id="tests">
        <h2>Could this just be luck, sport mix, or bet size?</h2>
        <p>A promising pattern is easy to manufacture accidentally. The analysis attacked this one in several different ways.</p>
        <div class="confidence-row">
            <div class="confidence-label high">Chronology</div>
            <div><strong>It stayed positive after selection.</strong> The 21 held-out signals returned ${pct(heldOut.roiPct, 1)}, including ${pct(breadthChronology.validation.roiPct, 1)} in validation and ${pct(breadthChronology.finalTest.roiPct, 1)} in the final block.</div>
        </div>
        <div class="confidence-row">
            <div class="confidence-label high">Composition</div>
            <div><strong>Similar markets still separated.</strong> Relabeling broad sweeps only within discipline, three price bands, and fixed time period produced an effect this large with one-sided <strong>p=${number(breadthPermutation.oneSidedPValue, 4)}</strong> across ${number(breadthPermutation.comparableBets)} comparable bets.</div>
        </div>
        <div class="confidence-row">
            <div class="confidence-label high">Trading days</div>
            <div><strong>One busy day did not create the result.</strong> Resampling whole days put the broad-minus-narrow probability gap at ${pp(dayContrast.estimatePctPoints, 1)}, with a 95% interval from ${pp(dayContrast.ci95LowPctPoints, 1)} to ${pp(dayContrast.ci95HighPctPoints, 1)}.</div>
        </div>
        <div class="confidence-row">
            <div class="confidence-label medium">Threshold search</div>
            <div><strong>The declared cutoff search was simulated under market probabilities.</strong> After repeating selection and held-out scoring ${number(thresholdNull.draws)} times, a held-out effect this large occurred with one-sided <strong>p=${number(thresholdNull.oneSidedPValue, 3)}</strong>.</div>
        </div>
        <div class="confidence-row">
            <div class="confidence-label high">Dollar size</div>
            <div><strong>Bigger notional did not explain breadth.</strong> A probability-offset model controlling for rapid flow, trigger notional, and time period estimated ${number(breadthCoefficient.oddsRatio, 2)} times the outcome odds for a broad sweep, robust p=${number(breadthCoefficient.robustPValue, 3)}. Trigger notional itself had odds ratio ${number(notionalCoefficient.oddsRatio, 2)} and p=${number(notionalCoefficient.robustPValue, 3)}.</div>
        </div>
        <div class="warning"><strong>Do not translate &ldquo;18 addresses&rdquo; into &ldquo;18 independent humans.&rdquo;</strong> They are distinct signed maker accounts. One person or market-making system can control multiple addresses. The feature measures real contract-level execution breadth, not human headcount.</div>
    </section>

    <figure>
        <img src="figures/alpha_subgroup_robustness.png" alt="Horizontal bars showing the broad-minus-narrow calibration advantage across disciplines, price bands, notional bands, timing, and flow speed.">
        <figcaption>Most descriptive slices retain a positive breadth advantage. The clear weak spot is the 70-85 cent entry-price band, and several sport cells are tiny. This chart is a map of where to challenge the rule, not a menu for subgroup optimization.</figcaption>
    </figure>

    <figure>
        <img src="figures/alpha_leave_one_discipline_out.png" alt="Bar chart showing all-period and held-out breadth ROI after removing each discipline in turn.">
        <figcaption>The weakest held-out leave-one-discipline-out result was still ${pct(weakestLeaveOneOut.heldOut.roiPct, 1)} after excluding ${weakestLeaveOneOut.excludedDiscipline}. No single sport or esport category creates the aggregate sign.</figcaption>
    </figure>

    <section id="risk">
        <h2>What the equity curve and drawdowns actually look like</h2>
        <p class="lead">Alpha is not the same as a smooth return stream. Losing contracts still lose the entire ${money(100)} stake, and a short sample can look stable by accident.</p>
        <table class="comparison">
            <thead><tr><th>Risk view</th><th class="number">Blind copy</th><th class="number">18+ makers</th><th class="number">Held out</th></tr></thead>
            <tbody>
                <tr><td>Bets</td><td class="number">${number(blindRisk.bets)}</td><td class="number">${number(breadthRisk.bets)}</td><td class="number">${number(heldOutRisk.bets)}</td></tr>
                <tr><td>ROI</td><td class="number negative">${pct(blindRisk.roiPct, 1)}</td><td class="number positive">${pct(breadthRisk.roiPct, 1)}</td><td class="number positive">${pct(heldOutRisk.roiPct, 1)}</td></tr>
                <tr><td>Maximum drawdown</td><td class="number">${money(blindRisk.maxDrawdownUsdc, 0)}</td><td class="number">${money(breadthRisk.maxDrawdownUsdc, 0)}</td><td class="number">${money(heldOutRisk.maxDrawdownUsdc, 0)}</td></tr>
                <tr><td>Longest losing streak</td><td class="number">${number(blindRisk.longestLossStreak)}</td><td class="number">${number(breadthRisk.longestLossStreak)}</td><td class="number">${number(heldOutRisk.longestLossStreak)}</td></tr>
                <tr><td>Worst rolling five bets</td><td class="number negative">${pct(blindRisk.worstFiveBetRoiPct, 1)}</td><td class="number negative">${pct(breadthRisk.worstFiveBetRoiPct, 1)}</td><td class="number negative">${pct(heldOutRisk.worstFiveBetRoiPct, 1)}</td></tr>
                <tr><td>Profitable trading days</td><td class="number">${number(blindRisk.profitableDays)} / ${number(blindRisk.tradingDays)}</td><td class="number">${number(breadthRisk.profitableDays)} / ${number(breadthRisk.tradingDays)}</td><td class="number">${number(heldOutRisk.profitableDays)} / ${number(heldOutRisk.tradingDays)}</td></tr>
                <tr><td>ROI after top five winners</td><td class="number negative">${pct(blindRisk.roiWithoutTopWinnersPct['5'], 1)}</td><td class="number positive">${pct(breadthRisk.roiWithoutTopWinnersPct['5'], 1)}</td><td class="number negative">${pct(heldOutRisk.roiWithoutTopWinnersPct['5'], 1)}</td></tr>
            </tbody>
        </table>
        <div class="warning"><strong>The most important risk caveat:</strong> the full 30-trade breadth sample remains positive after removing its five best winners, but the 21-trade held-out half does not. That does not erase the discovery; it shows why 200 genuinely new paper signals are required before any live-money claim.</div>
    </section>

    <figure>
        <img src="figures/alpha_equity_drawdown.png" alt="Chronological equity and drawdown charts for broad and narrow trigger transactions.">
        <figcaption>The broad curve separates early and stays positive through validation and final test. Narrow triggers deteriorate sharply. Vertical lines show the development and validation boundaries.</figcaption>
    </figure>

    <figure>
        <img src="figures/alpha_daily_pnl.png" alt="Daily breadth-strategy profit bars with a cumulative profit line.">
        <figcaption>Profits arrive on clusters of signal days rather than evenly. That dependence is why the report resamples whole trading days instead of pretending every event is independent.</figcaption>
    </figure>

    <figure>
        <img src="figures/breadth_execution_sensitivity.png" alt="Line chart showing broad-sweep returns under increasingly adverse execution assumptions.">
        <figcaption>At the original 60-second mark, the breadth rule remains positive as the assumed price penalty rises. At ten cents, all broad signals return ${pct(stressTen.all.roiPct, 1)} and the held-out half returns ${pct(stressTenHeldOutRoi, 1)}. The held-out line reaches break-even near 20 cents.</figcaption>
    </figure>

    <figure>
        <img src="figures/execution_sensitivity.png" alt="Line chart showing the broader filtered universe losing return as adverse execution movement rises.">
        <figcaption>The wider eligible universe is much less forgiving. This is why a realistic copy test must report price impact rather than assuming the bot receives the whale's fill.</figcaption>
    </figure>

    <section>
        <h2>What the alpha reveals, and what remains hidden</h2>
        <div class="confidence-row">
            <div class="confidence-label high">Chain fact</div>
            <div><strong>The wallet selectively takes broad liquidity.</strong> The triggering calldata directly names the maker orders consumed. Breadth is observable once the transaction is mined.</div>
        </div>
        <div class="confidence-row">
            <div class="confidence-label high">Sample fact</div>
            <div><strong>Those broad sweeps contain the forecasting value.</strong> They won above public-price expectations; narrower triggers did not. Dollar size does not account for the difference.</div>
        </div>
        <div class="confidence-row">
            <div class="confidence-label medium">Interpretation</div>
            <div><strong>The behavior looks like informed liquidity demand.</strong> The trader is willing to clear many standing offers immediately when waiting appears more dangerous than crossing the book.</div>
        </div>
        <div class="confidence-row">
            <div class="confidence-label unknown">Source</div>
            <div><strong>The information source remains invisible.</strong> Public data cannot distinguish a superior sports model, faster public feeds, private information, coordinated research, or disciplined human judgment.</div>
        </div>
        <p>The discovery is not the trader's secret model. It is the best externally observable signature of when that hidden process is expressing unusually strong conviction.</p>

        <h3>Why the rest of the wallet still matters</h3>
        <ul class="fact-list">
            <li>Maker orders were ${plainPct(analysis.execution.makerFillPct, 1)} of fills but only ${plainPct(analysis.execution.makerNotionalPct, 1)} of dollars. Fill count alone exaggerates routine activity.</li>
            <li>True multi-map series earned ${money(format.multiMapSeries.realizedPnlUsdc)} at ${pct(format.multiMapSeries.roiPct, 1)}. Single-game and map contracts lost ${money(Math.abs(format.singleGameOrMap.realizedPnlUsdc))}.</li>
            <li>The first visible buy poorly predicted eventual position size; the chronological sizing model had out-of-sample R-squared ${number(edge.sizing.chronologicalTest.r2LogCost, 3)}.</li>
            <li>The whale can size, make markets, sell, and manage inventory. A follower can reproduce none of that by copying a public feed row.</li>
        </ul>
    </section>

    <section>
        <h2>The honest reasons for doubt</h2>
        <ul class="fact-list">
            <li><strong>Thirty is small.</strong> The full breadth result has 30 bets; only 21 occurred after threshold selection.</li>
            <li><strong>The held-out win-count test is suggestive, not decisive.</strong> Its one-sided Poisson-binomial p-value is ${number(heldOutCalibration.poissonBinomialUpperTailPValue, 3)}.</li>
            <li><strong>The threshold-search simulation is barely below 0.05.</strong> Its p-value is ${number(thresholdNull.oneSidedPValue, 3)}, not overwhelming evidence.</li>
            <li><strong>The ${number(atlasCells)} atlas cells are not ${number(atlasCells)} confirmations.</strong> They map sensitivity around one frozen rule. Treating the best cell as a new discovery would be parameter mining.</li>
            <li><strong>The ${number(capacity.scenarioCount)} capacity cells are also not independent evidence.</strong> They reuse the same events while varying stake, window, buffer, participation, and print proxy.</li>
            <li><strong>The wallet and feature family were chosen retrospectively.</strong> The null simulation corrects the stated maker-count cutoff search, not every idea considered during the investigation.</li>
            <li><strong>The compact-fresh mechanism is second-stage research.</strong> Its held-out block contains only seven bets, and its cluster interval includes a loss.</li>
            <li><strong>The history spans roughly two months.</strong> A market regime, one operator, or one sports calendar can change.</li>
            <li><strong>The held-out result is winner-concentrated.</strong> Removing its five most profitable winners changes held-out ROI to ${pct(heldOutRisk.roiWithoutTopWinnersPct['5'], 1)}.</li>
            <li><strong>Execution is still a proxy.</strong> Public prints show activity, not guaranteed historical ask depth, queue position, partial fills, or API publication latency.</li>
            <li><strong>Closing-line value is negative.</strong> The pregame market did not independently confirm the broad-sweep side before play.</li>
        </ul>
        <div class="warning"><strong>Correct conclusion:</strong> this is a real, testable discovery in the available sample, not proof of future profit. It earns a frozen prospective paper test. It does not earn live capital yet.</div>
    </section>

    <section>
        <h2>Facts, interpretation, and speculation</h2>
        <table>
            <thead><tr><th>Claim</th><th>Classification</th><th>Why</th></tr></thead>
            <tbody>
                <tr><td>Blindly copying every large signal lost money.</td><td><strong class="positive">Observed fact</strong></td><td>${number(blind.all.bets)} forced bets under declared execution assumptions.</td></tr>
                <tr><td>All trigger transactions made the wallet the BUY taker.</td><td><strong class="positive">On-chain fact</strong></td><td>${number(edge.coverage.targetAsDecodedTaker)} of ${number(edge.coverage.decodedTriggerTransactions)} decoded V2 transactions.</td></tr>
                <tr><td>Sweeps across 18 or more makers carried the edge.</td><td><strong class="positive">Observed in sample</strong></td><td>23 wins from 30, ${pct(breadth.roiPct, 1)} ROI, with a positive held-out half.</td></tr>
                <tr><td>Compact, fresh breadth is the closest observable mechanism.</td><td><strong class="positive">Exploratory lead</strong></td><td>6/7 held out, but selected post-hoc and the day-cluster interval includes losses.</td></tr>
                <tr><td>Blind copy bots must be under one second.</td><td><strong class="negative">Not supported</strong></td><td>No sub-minute latency cliff appeared; roughly two cents of adverse price erased the blind-copy margin.</td></tr>
                <tr><td>A ${money(10000)} copy fills like a ${money(100)} copy.</td><td><strong class="negative">False</strong></td><td>Current +1c FOK coverage fell from ${plainPct(liveCapacityCell(100).fillRatePct, 1)} at ${money(100)} to ${plainPct(liveCapacityCell(10000).fillRatePct, 1)} at ${money(10000)} even in a favorable liquid-market sample.</td></tr>
                <tr><td>Breadth is only a disguise for dollar size.</td><td><strong class="negative">Not supported</strong></td><td>Notional was null after breadth, urgency, and period controls: p=${number(notionalCoefficient.robustPValue, 3)}.</td></tr>
                <tr><td>Closing prices confirm the broad-sweep information.</td><td><strong class="negative">Not supported</strong></td><td>Median broad pregame CLV was ${number(closing.breadthPregame.medianClosingLineValueCents, 2)}c; only ${number(closing.breadthPregame.positiveClosingLineEvents)}/${number(closing.breadthPregame.events)} were positive.</td></tr>
                <tr><td>The trader has private information.</td><td><strong class="negative">Not established</strong></td><td>Behavior is consistent with informed trading, but public data cannot identify the source.</td></tr>
                <tr><td>The algorithm is ready for live money.</td><td><strong class="negative">No</strong></td><td>Short history, 21 post-selection bets, and proxy execution still leave material uncertainty.</td></tr>
            </tbody>
        </table>
    </section>

    <section id="verdict" class="verdict">
        <h2>The honest verdict</h2>
        <p><strong>The discovery is not &ldquo;copy this whale.&rdquo;</strong> That strategy lost.</p>
        <p><strong>His edge, as far as public evidence can reveal it, is knowing when to accept a dense block of fresh liquidity from many counterparties without chasing far through price levels.</strong> Broad, compact, fresh atomic sweeps are the closest observable footprint. The hidden model, feed, information, or judgment that causes him to act remains private.</p>
        <p>The frozen algorithm is <strong>atomic-breadth-18</strong>. Historical result: ${number(breadth.wins)} wins from ${number(breadth.bets)}, ${pct(breadth.roiPct, 2)} after the original stressed costs. Post-selection result: ${number(heldOut.wins)} wins from ${number(heldOut.bets)}, ${pct(heldOut.roiPct, 2)}.</p>
        <p>For an indiscriminate bot, the historical break-even execution allowance at one second was only ${number(blindOneSecondBreakEven.allMaxAdverseCents, 2)} cents. Size adds a second failure mode: the order can be completely rejected. The lesson is not &ldquo;buy a faster server.&rdquo; It is &ldquo;reject weak signals, cap depth participation, and control the paid price.&rdquo;</p>
        <p><strong>Decision:</strong> run the capacity-aware monitor for at least 200 new eligible paper signals without changing the 18-maker rule. Shadow-score compact-fresh geometry. Record decoded transaction shape, actual book depth, FOK rejection, VWAP, end-to-end latency, closing line, and resolution. Capital waits until a genuinely unseen sample has positive CLV and remains profitable after real fill constraints and after removing its biggest winners.</p>
    </section>

    <section>
        <h2>Small glossary</h2>
        <dl class="glossary">
            <dt>Maker</dt><dd>A trader who leaves an order waiting in the book and provides liquidity.</dd>
            <dt>Taker</dt><dd>A trader who accepts an available price immediately. Takers usually reveal more urgency and pay more.</dd>
            <dt>Atomic sweep</dt><dd>One mined transaction in which a taker order matches several already-signed maker orders together.</dd>
            <dt>Maker breadth</dt><dd>The number of distinct maker addresses consumed by that transaction. It counts accounts, not verified people.</dd>
            <dt>Adverse price</dt><dd>How many extra cents a follower pays above the first public execution reference because of spread, consumed depth, or market reaction.</dd>
            <dt>FOK</dt><dd>Fill or kill. The entire requested order trades immediately at or below its limit, or none of it trades.</dd>
            <dt>VWAP</dt><dd>Volume-weighted average price across every ask level needed to fill an order. It is the true average paid when one order walks several prices.</dd>
            <dt>Closing-line value</dt><dd>The final pregame probability minus the entry probability for the selected side. Positive means the market moved toward the bet before play.</dd>
            <dt>Maker-order age</dt><dd>How long a signed maker order had been resting when the target consumed it. Fresh means recently posted, not necessarily well informed.</dd>
            <dt>Implied probability</dt><dd>A 60-cent contract roughly represents a market-estimated 60% chance before trading costs.</dd>
            <dt>Calibration gap</dt><dd>The actual win rate minus the win rate implied by prices. Positive is good only if it survives costs and honest testing.</dd>
            <dt>ROI</dt><dd>Profit divided by total stake. A 10% ROI means ${money(10)} profit for each ${money(100)} staked.</dd>
            <dt>p-value</dt><dd>A narrow measure of how often a result at least this large appears under a specified random null. It is not the probability that the strategy is true.</dd>
            <dt>Confidence interval</dt><dd>A range showing statistical uncertainty under a particular resampling method. It does not include every source of bias.</dd>
        </dl>
    </section>

    <section class="sources">
        <h2>Where the facts came from</h2>
        <p>This essay is a human-readable rendering of committed machine-readable evidence. The core calculations can be audited in:</p>
        <ul>
            <li><a href="edge_analysis.json">edge_analysis.json</a>: blind-copy and atomic-breadth backtests, chronology, null simulation, controls, ${number(atlasCells)} parameter-atlas cells, risk diagnostics, and break-even frontiers.</li>
            <li><a href="liquidity_capacity.json">liquidity_capacity.json</a>: timestamped current CLOB ask ladders and exact FOK walks across stake and price-buffer scenarios.</li>
            <li><a href="closing_lines.json">closing_lines.json</a>: final non-target pregame public prints used for the independent closing-line audit.</li>
            <li><a href="edge_features.csv">edge_features.csv</a>: one row per reconstructed signal, including decoded maker breadth and information available by signal time.</li>
            <li><a href="trigger_transactions.json">trigger_transactions.json</a>: decoded <code>matchOrders</code> calldata and derived fill anatomy for all ${number(edge.coverage.decodedTriggerTransactions)} trigger transactions.</li>
            <li><a href="deep_analysis.json">deep_analysis.json</a>: wallet-level execution, market format, profit, fee, and concentration facts.</li>
            <li><a href="market_tape.json">market_tape.json</a>: ${number(edge.coverage.publicTakerPrints)} unrelated public prints used for execution proxies and market response.</li>
        </ul>
        <p>External context:</p>
        <ul>
            <li><a href="https://github.com/Polymarket/ctf-exchange-v2">Official Polymarket CTF Exchange V2 repository</a>, including <a href="https://github.com/Polymarket/ctf-exchange-v2/blob/main/src/exchange/mixins/Trading.sol"><code>matchOrders</code> execution</a> and the <a href="https://github.com/Polymarket/ctf-exchange-v2/blob/main/src/exchange/libraries/Structs.sol">signed order structure</a>.</li>
            <li><a href="https://docs.polymarket.com/concepts/order-lifecycle">Official Polymarket order lifecycle</a>, distinguishing off-chain <code>MATCHED</code>, on-chain <code>MINED</code>, and final <code>CONFIRMED</code> trade states.</li>
            <li><a href="https://docs.polymarket.com/api-reference/market-data/get-order-book">Official Polymarket order-book endpoint</a> and <a href="https://docs.polymarket.com/api-reference/market-data/get-order-books-request-body">batch order-book endpoint</a>, used for the current displayed-depth snapshot.</li>
            <li><a href="https://docs.polymarket.com/concepts/order-lifecycle">Official FOK lifecycle documentation</a>: a fill-or-kill order must execute completely or reject.</li>
            <li><a href="https://docs.polymarket.com/trading/fees">Official Polymarket fee documentation</a>, including the probability-dependent fee formula used in the paper calculations.</li>
            <li><a href="https://docs.polymarket.com/api-reference/wss/market">Official public market WebSocket</a>, documenting millisecond-stamped book and trade events available prospectively but absent from this historical second-resolution tape.</li>
            <li><a href="https://arxiv.org/abs/2604.24366">Dubach, The Anatomy of a Decentralized Prediction Market</a>, supporting use of authoritative on-chain direction rather than potentially ambiguous public labels.</li>
            <li><a href="https://doi.org/10.1016/0304-405X(87)90029-8">Easley and O'Hara, Price, Trade Size, and Information in Securities Markets</a>, classic context for why aggressive trade structure can contain information.</li>
            <li><a href="https://arxiv.org/abs/2605.00864">Cheng, Yang, and Zou, Arbitrage Analysis in Polymarket NBA Markets</a>, independent order-book evidence that executable opportunities can be sharply bounded by shallow depth. It is microstructure context, not validation of this wallet strategy.</li>
            <li><a href="https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf">Bailey et al., The Probability of Backtest Overfitting</a>.</li>
        </ul>
        <p><strong>Limit:</strong> this is public-wallet research, not proof of identity, distinct human counterparties, private information, causality, historical executable depth, or future profit. It is not financial advice.</p>
    </section>
</main>

<footer>
    <div class="page">Polymarket trader investigation &middot; 31-figure alpha, capacity, and execution dossier &middot; Generated from committed evidence</div>
</footer>
</body>
</html>`;
}

function findChromium() {
    const candidates = [
        process.env.CHROME_BIN,
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome'
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate));
}

function renderPdf() {
    const chromium = findChromium();
    if (!chromium) throw new Error('Chromium is required for --pdf output; set CHROME_BIN');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'polymarket-essay-'));
    try {
        const result = spawnSync(chromium, [
            '--headless',
            '--no-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--no-pdf-header-footer',
            `--user-data-dir=${profile}`,
            `--print-to-pdf=${OUTPUT_PDF}`,
            pathToFileURL(OUTPUT_HTML).href
        ], { encoding: 'utf8' });
        if (result.status !== 0 || !fs.existsSync(OUTPUT_PDF)) {
            throw new Error(result.stderr || result.stdout || 'Chromium PDF rendering failed');
        }
    } finally {
        fs.rmSync(profile, { recursive: true, force: true });
    }
}

function main() {
    const analysis = readJson('deep_analysis.json');
    const edge = readJson('edge_analysis.json');
    fs.writeFileSync(OUTPUT_HTML, `${renderHtml(analysis, edge)}\n`, 'utf8');
    if (process.argv.includes('--pdf')) renderPdf();
    const outputs = [path.relative(ROOT, OUTPUT_HTML)];
    if (process.argv.includes('--pdf')) outputs.push(path.relative(ROOT, OUTPUT_PDF));
    console.log(`Plain-English essay: ${outputs.join(', ')}`);
}

if (require.main === module) main();

module.exports = { renderHtml };
