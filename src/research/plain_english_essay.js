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
    const fixed = edge.fixedExternalTapeBacktest;
    const chronology = edge.subgroupChronology;
    const mechanism = edge.mechanismAudit;
    const rapid = mechanism.calibration.burst60;
    const slow = mechanism.calibration.slower;
    const clustered = mechanism.calibration.dayClusterBootstrap;
    const broad = mechanism.compositionControls.broadCmh;
    const fine = mechanism.compositionControls.finePermutation;
    const model = edge.walkForwardModel;
    const format = analysis.performance.formatAudit;
    const rapidPregame = mechanism.byTimingAndUrgency.find((row) =>
        row.key === 'pregame' && row.urgency === 'rapid');
    const rapidLive = mechanism.byTimingAndUrgency.find((row) =>
        row.key === 'in-play' && row.urgency === 'rapid');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="A plain-English, illustrated investigation of what would have happened when copying a high-volume Polymarket trader.">
<title>Copying the Whale Would Have Lost Money</title>
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
        .two-column, .confidence-row { grid-template-columns: 1fr; gap: 6px; }
        .contents a { display: inline-block; margin-bottom: 8px; }
        table { font-size: 14px; }
        th, td { padding-left: 7px; padding-right: 7px; }
    }

    @media print {
        @page { size: A4; margin: 14mm 13mm 15mm; }
        body { font-size: 11pt; line-height: 1.48; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
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
        .bottom-line, .warning, .finding, .plain-language, .rule, .verdict { break-inside: avoid; page-break-inside: avoid; }
        figure img { max-height: 178mm; object-fit: contain; }
        a { color: inherit; }
        .sources { font-size: 10pt; }
        .sources p { margin-bottom: 8px; }
        .sources li { margin-bottom: 2px; }
        footer { padding-bottom: 0; }
    }
</style>
</head>
<body>
<header class="masthead">
    <div class="page">
        <p class="kicker">Plain-English investigation</p>
        <h1>Copying the whale would have lost money.</h1>
        <p class="dek">The trader made millions. A delayed follower copying every large signal would still have lost. The useful clue was not how much he eventually bet, but how quickly he crossed the market.</p>
        <p class="dateline">Public-data study covering ${isoDate(analysis.coverage.firstTrade)} to ${isoDate(analysis.coverage.lastTrade)}. Analysis generated ${isoDate(edge.generatedAt)}.</p>
        <div class="headline-facts" aria-label="Headline findings">
            <div class="headline-fact"><strong class="negative">${pct(blind.all.roiPct, 2)}</strong><span>return from blindly copying all ${number(blind.all.bets)} large signals</span></div>
            <div class="headline-fact"><strong class="positive">${pct(chronology.all.burst60.roiPct, 2)}</strong><span>return from the rapid-signal subset in the same stressed simulation</span></div>
            <div class="headline-fact"><strong class="neutral">${pp(clustered.burstMinusSlower.estimatePctPoints, 1)}</strong><span>rapid-versus-slow probability gap before the strictest control</span></div>
        </div>
    </div>
</header>

<main class="page">
    <nav class="contents" aria-label="Essay contents">
        <a href="#answer">The answer</a>
        <a href="#copying">Blind copying</a>
        <a href="#discovery">The clue</a>
        <a href="#edge">Possible edge</a>
        <a href="#doubt">Reasons for doubt</a>
        <a href="#verdict">Verdict</a>
    </nav>

    <section id="answer">
        <h2>The answer in thirty seconds</h2>
        <p class="lead">This wallet is genuinely exceptional, but the visible headline &ldquo;large winning trader&rdquo; is not itself a tradable signal.</p>
        <div class="bottom-line"><strong>Bottom line:</strong> copying every large buy lost money. The only repeatable-looking clue was a sudden burst of aggressive buying in full-event markets before the public price fully caught up. That clue is promising enough to test on paper, but not strong enough to risk real money.</div>
        <ol class="steps">
            <li><strong>The trader made ${money(analysis.performance.realizedPnlUsdc)}.</strong> But the top five winners produced ${plainPct(analysis.concentration.top5ContributionPct, 0)} of total net profit. Without those five, the wallet would be down ${money(Math.abs(analysis.concentration.pnlWithoutTop5Usdc))}.</li>
            <li><strong>A follower cannot buy at the trader's old price.</strong> The fair copy test waits 60 seconds, uses another public trade as the price, adds five cents of adverse movement, and charges the observed fee curve.</li>
            <li><strong>Blind copying failed.</strong> ${number(blind.all.bets)} equal ${money(100)} bets lost ${money(Math.abs(blind.all.profitUsdc), 2)} and suffered a ${money(blind.all.maxDrawdownUsdc, 2)} maximum drawdown.</li>
            <li><strong>Speed separated the good signals from the bad ones.</strong> Rapid signals returned ${pct(chronology.all.burst60.roiPct, 2)}; slow signals returned ${pct(chronology.all.slower.roiPct, 2)}.</li>
        </ol>
    </section>

    <figure>
        <img src="figures/blind_copy_funnel.png" alt="Bar chart showing blind copying losing money and rapid, format, discipline, and price filters progressively improving the result.">
        <figcaption><strong>How to read this:</strong> the first row is the naive strategy. It loses both over the full history and after the fixed date split. The first rule that turns the result positive is urgency. Discipline and price filters improve it further, but those last two filters were discovered in this same sample and deserve less trust.</figcaption>
    </figure>

    <section id="copying">
        <h2>What &ldquo;blind copying&rdquo; actually means</h2>
        <p>We did not pretend a follower could magically enter at the whale's price. The copy test was deliberately ordinary and mechanical:</p>
        <ol class="steps">
            <li>Wait until the target has crossed <strong>${money(25000)}</strong> of aggressive buying and at least 70% of its net direction points to one outcome.</li>
            <li>Keep only the first signal for each underlying match, so a series and its individual maps cannot be counted as independent ideas.</li>
            <li>Wait <strong>60 seconds</strong>, then use the first unrelated public trade in the following minute as the available price. If none appears, retain the trigger price.</li>
            <li>Make the price five cents worse, include the account-observed fee curve, and place the same <strong>${money(100)}</strong> stake every time.</li>
        </ol>
        <p>The total stake across all bets was ${money(blind.all.stakeUsdc)}. That is turnover across the test, not necessarily ${money(blind.all.stakeUsdc)} tied up at once. The result was ${number(blind.all.wins)} wins, ${number(blind.all.bets - blind.all.wins)} losses, and ${money(blind.all.profitUsdc, 2)} net profit.</p>
        <div class="warning"><strong>The important fact:</strong> the later ${number(blind.later.bets)} signals also lost money at ${pct(blind.later.roiPct, 2)}. The loss was not confined to an early learning period.</div>

        <h3>Why winning more than half the bets was not enough</h3>
        <p>Prediction-market prices already contain a probability. Buying a contract at 60 cents means paying roughly as if it has a 60% chance to win. A strategy can win 58% of its bets and still lose if it repeatedly pays prices that require a higher hit rate.</p>
        <p>Blind copying won ${number(blind.calibration.wins)} times. The public prices implied about ${number(blind.calibration.expectedWinsFromExecutionProxy, 2)} wins. That difference was only ${pp(blind.calibration.calibrationGapPctPoints, 1)}, with a diagnostic probability of <strong>${number(blind.calibration.poissonBinomialUpperTailPValue * 100, 1)}%</strong>. In ordinary language: the extra wins were not unusual enough to show a generic large-bet edge.</p>
    </section>

    <figure>
        <img src="figures/strategy_equity.png" alt="Chronological cumulative profit chart comparing blind copying with progressively filtered strategies.">
        <figcaption>The red blind-copy line remains underwater. The filtered lines improve, but their stronger performance comes from taking fewer, more specific signals. This chart is historical attribution, not a promise about the next trade.</figcaption>
    </figure>

    <section id="discovery">
        <h2>The useful clue: conviction compression</h2>
        <p class="lead">The best plain-English description is: <strong>the trader looks more informative when he buys suddenly, not merely when he buys big.</strong></p>
        <div class="plain-language"><b>Size</b> tells us how loud the final bet became. <b>Compression</b> tells us how urgently the trader was willing to pay the market's price right now.</div>
        <p>A signal is called <strong>rapid</strong> when at least 80% of the target's aggressive buying observed at the trigger arrived in the final 60 seconds. Everything else is called <strong>slow</strong>. Both groups use the same delayed public-price method, five-cent stress, and fees.</p>

        <table class="comparison">
            <thead><tr><th>What happened</th><th class="number">Rapid</th><th class="number">Slow</th></tr></thead>
            <tbody>
                <tr><td>Number of bets</td><td class="number">${number(rapid.bets)}</td><td class="number">${number(slow.bets)}</td></tr>
                <tr><td>Wins implied by public prices</td><td class="number">${number(rapid.expectedWinsFromExecutionProxy, 2)}</td><td class="number">${number(slow.expectedWinsFromExecutionProxy, 2)}</td></tr>
                <tr><td>Actual wins</td><td class="number positive">${number(rapid.wins)}</td><td class="number negative">${number(slow.wins)}</td></tr>
                <tr><td>Price-implied win rate</td><td class="number">${plainPct(rapid.meanImpliedProbabilityPct, 1)}</td><td class="number">${plainPct(slow.meanImpliedProbabilityPct, 1)}</td></tr>
                <tr><td>Actual win rate</td><td class="number positive">${plainPct(rapid.actualWinRatePct, 1)}</td><td class="number negative">${plainPct(slow.actualWinRatePct, 1)}</td></tr>
                <tr><td>Gap versus price</td><td class="number positive">${pp(rapid.calibrationGapPctPoints, 1)}</td><td class="number negative">${pp(slow.calibrationGapPctPoints, 1)}</td></tr>
                <tr><td>Equal-stake return</td><td class="number positive">${pct(chronology.all.burst60.roiPct, 2)}</td><td class="number negative">${pct(chronology.all.slower.roiPct, 2)}</td></tr>
            </tbody>
        </table>

        <p>The split did not appear only in one half of history. Earlier rapid signals returned ${pct(chronology.earlier70Pct.burst60.roiPct, 1)} versus ${pct(chronology.earlier70Pct.slower.roiPct, 1)} for slow signals. After the fixed date split, rapid signals returned ${pct(chronology.final30Pct.burst60.roiPct, 1)} versus ${pct(chronology.final30Pct.slower.roiPct, 1)}.</p>
        <p>It also was not merely a live-score trick. Rapid pregame signals returned ${pct(rapidPregame.roiPct, 1)} and rapid in-play signals returned ${pct(rapidLive.roiPct, 1)}. That does not identify the information source, but it rules out the simplest story that the result comes only from reacting to a visible live score.</p>
        <div class="finding"><strong>What the day-level check says:</strong> after resampling whole trading days, the estimated rapid-minus-slow probability gap was ${pp(clustered.burstMinusSlower.estimatePctPoints, 1)}, with a 95% interval from ${pp(clustered.burstMinusSlower.ci95LowPctPoints, 1)} to ${pp(clustered.burstMinusSlower.ci95HighPctPoints, 1)}. This protects against one busy day being counted as dozens of independent discoveries. It does not correct for the fact that we found the rule while studying this wallet.</div>
    </section>

    <figure>
        <img src="figures/urgency_calibration.png" alt="Bar chart comparing public implied probability with actual win rate for rapid and slow signals in the full, earlier, and later samples.">
        <figcaption>The public execution price is similar across rapid and slow groups, but realized outcomes separate sharply. The later slow group has only five observations, so its bar is descriptive rather than reliable on its own.</figcaption>
    </figure>

    <section id="edge">
        <h2>So what might his edge actually be?</h2>
        <p>The evidence points to a <strong>decision process</strong>, not a magic wallet address. The trader appears to run a large maker or inventory operation most of the time, then cross liquidity aggressively when conviction spikes.</p>

        <div class="confidence-row">
            <div class="confidence-label high">Strong fact</div>
            <div><strong>Aggressive flow matters more than fill count.</strong> Maker orders were ${plainPct(analysis.execution.makerFillPct, 1)} of fills but only ${plainPct(analysis.execution.makerNotionalPct, 1)} of dollars. A small aggressive core carried most of the economic exposure.</div>
        </div>
        <div class="confidence-row">
            <div class="confidence-label high">Strong fact</div>
            <div><strong>Contract choice matters.</strong> True multi-map series earned ${money(format.multiMapSeries.realizedPnlUsdc)} at ${pct(format.multiMapSeries.roiPct, 1)}. Single games and maps lost ${money(Math.abs(format.singleGameOrMap.realizedPnlUsdc))} at ${pct(format.singleGameOrMap.roiPct, 1)}.</div>
        </div>
        <div class="confidence-row">
            <div class="confidence-label medium">Best hypothesis</div>
            <div><strong>Urgent buys may reveal fresh information, a superior model, or unusually strong conviction before the market reprices.</strong> The public tape often showed little median movement for several minutes, leaving a possible observation window.</div>
        </div>
        <div class="confidence-row">
            <div class="confidence-label medium">Likely structure</div>
            <div><strong>The edge looks like informed liquidity demand.</strong> In ordinary terms, the trader pays fees to get filled immediately only when waiting seems more dangerous than paying the spread.</div>
        </div>
        <div class="confidence-row">
            <div class="confidence-label unknown">Unknown</div>
            <div><strong>We do not know the information source.</strong> Public data cannot distinguish private information, better esports or sports models, faster public feeds, a syndicate, or disciplined discretionary judgment.</div>
        </div>

        <h3>Why final bet size is not the answer</h3>
        <p>The first observable buy poorly predicted how large the final position became. The chronological sizing model had an out-of-sample <strong>R-squared of ${number(edge.sizing.chronologicalTest.r2LogCost, 3)}</strong>, which is worse than using a simple baseline. Its mean error was ${money(edge.sizing.chronologicalTest.meanAbsoluteErrorUsdc)}. A follower can see urgency; a follower cannot reliably know the whale's eventual stake.</p>

        <h3>Why a winning whale can still be a losing copy</h3>
        <ul class="fact-list">
            <li>The whale often entered earlier and at a better price.</li>
            <li>The whale chose position size unevenly; the copy test deliberately did not know future conviction.</li>
            <li>The wallet could manage inventory, sell, or collect maker rebates. A follower copying one visible buy cannot reproduce the whole operation.</li>
            <li>Five huge winners supplied more than all net profit because other trades lost money.</li>
            <li>Delay, spread, adverse movement, and fees turn a small forecasting edge into a trading loss.</li>
        </ul>
    </section>

    <figure>
        <img src="figures/burst_threshold_sensitivity.png" alt="Line and bar chart showing returns, calibration gap, and sample size as the rapid-buy threshold changes from 50 to 99 percent.">
        <figcaption>The rapid result stays positive across nearby definitions, so 80% is not one lucky exact cutoff. The same bets overlap across thresholds, however; this is one sensitivity check, not seven independent confirmations.</figcaption>
    </figure>

    <section id="doubt">
        <h2>How hard did the idea get punched?</h2>
        <p>A serious investigation must show the evidence against its favorite explanation. This one has a meaningful negative result.</p>
        <div class="two-column">
            <div>
                <h3>What survived</h3>
                <ul class="fact-list">
                    <li>Blind copying was negative both before and after the fixed split.</li>
                    <li>Rapid signals beat slow signals in both chronological periods.</li>
                    <li>A broad comparison within discipline and broad price groups estimated ${number(broad.commonOddsRatio, 2)} times the win odds, with <strong>p=${number(broad.twoSidedPValue, 3)}</strong>.</li>
                    <li>The rapid result appeared in both pregame and in-play signals.</li>
                </ul>
            </div>
            <div>
                <h3>What did not survive</h3>
                <ul class="fact-list">
                    <li>The strictest comparison kept only similar discipline, price band, and time-period groups.</li>
                    <li>Only ${number(fine.comparableBets)} comparable bets remained.</li>
                    <li>Randomly relabeling urgency within those groups did as well as the real labels about ${plainPct(fine.oneSidedPValue * 100, 1)} of the time.</li>
                    <li>That is too common to call statistical confirmation. Composition may explain part of the raw gap.</li>
                </ul>
            </div>
        </div>
        <div class="warning"><strong>Plain-English meaning of p=${number(fine.oneSidedPValue, 3)}:</strong> after forcing tighter apples-to-apples comparisons, the result was no longer rare under random relabeling. The candidate may be real, but this dataset cannot prove it.</div>

        <h3>Execution can consume the whole advantage</h3>
        <p>The cleaned ${number(fixed.all.bets)}-event baseline returned ${pct(fixed.all.roiPct, 2)} at five cents of adverse movement. Near ten cents, the aggregate edge disappeared. A backtest that ignores available depth, failed fills, and changing prices would be fantasy.</p>
    </section>

    <figure>
        <img src="figures/execution_sensitivity.png" alt="Line chart showing returns falling as assumed adverse execution movement rises.">
        <figcaption>The strategy is sensitive to the price actually paid. The later period looks strongest, but it also has the fewest observations. Public trades prove activity, not that a ${money(100)} fill was available at exactly that price and depth.</figcaption>
    </figure>

    <section>
        <h2>Facts, interpretation, and speculation</h2>
        <table>
            <thead><tr><th>Claim</th><th>Classification</th><th>Why</th></tr></thead>
            <tbody>
                <tr><td>Blindly copying every large signal lost money.</td><td><strong class="positive">Observed fact</strong></td><td>${number(blind.all.bets)} forced bets under declared execution assumptions.</td></tr>
                <tr><td>Rapid target buying separated winners from slow buying.</td><td><strong class="positive">Observed in sample</strong></td><td>${number(rapid.bets)} rapid and ${number(slow.bets)} slow eligible bets, with opposite calibration gaps.</td></tr>
                <tr><td>Urgency is the trader's true causal edge.</td><td><strong class="neutral">Plausible hypothesis</strong></td><td>Chronology and broad controls support it; the strict permutation does not confirm it.</td></tr>
                <tr><td>The trader has private information.</td><td><strong class="negative">Not established</strong></td><td>Behavior is consistent with informed trading, but public data cannot identify the source.</td></tr>
                <tr><td>The historical model is ready for live money.</td><td><strong class="negative">No</strong></td><td>The model selected only ${number(model.selected.bets)} bets; its day-clustered interval runs from ${pct(model.selectedDayClusterBootstrap.ci95LowPct, 1)} to ${pct(model.selectedDayClusterBootstrap.ci95HighPct, 1)}.</td></tr>
            </tbody>
        </table>
    </section>

    <section id="verdict" class="verdict">
        <h2>The honest verdict</h2>
        <p><strong>The discovery is not &ldquo;copy this whale.&rdquo;</strong> That strategy lost.</p>
        <p>The useful discovery is narrower: when this trader's aggressive buying arrives in a compressed burst, in a full-match or multi-map contract, the chosen side has historically won much more often than the delayed public price implied.</p>
        <p>That pattern is economically coherent and survived several checks. It also failed the strictest low-powered composition test, depends on a short two-month sample, and remains exposed to real execution costs.</p>
        <p><strong>Decision:</strong> freeze the rule and collect at least 200 new eligible signals in paper mode, including actual order-book depth and failed fills. Do not deploy capital until a genuinely unseen sample stays profitable after costs and after removing the biggest winners.</p>
    </section>

    <section>
        <h2>Small glossary</h2>
        <dl class="glossary">
            <dt>Maker</dt><dd>A trader who leaves an order waiting in the book and provides liquidity.</dd>
            <dt>Taker</dt><dd>A trader who accepts an available price immediately. Takers usually reveal more urgency and pay more.</dd>
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
            <li><a href="edge_analysis.json">edge_analysis.json</a>: blind-copy backtest, calibration, chronology, controls, execution stress, and model results.</li>
            <li><a href="edge_features.csv">edge_features.csv</a>: one row per reconstructed signal with only information available by signal time.</li>
            <li><a href="deep_analysis.json">deep_analysis.json</a>: wallet-level execution, market format, profit, fee, and concentration facts.</li>
            <li><a href="market_tape.json">market_tape.json</a>: ${number(edge.coverage.publicTakerPrints)} unrelated public prints used for execution proxies and market response.</li>
        </ul>
        <p>External context:</p>
        <ul>
            <li><a href="https://docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets">Polymarket Data API trade documentation</a>.</li>
            <li><a href="https://www.nber.org/papers/w6129">Engle and Lange, Measuring, Forecasting and Explaining Time Varying Liquidity</a>.</li>
            <li><a href="https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6933527">Le, Beyond Liquidity: Informed Trading in Decentralized Prediction Markets</a>.</li>
            <li><a href="https://arxiv.org/abs/2604.24366">Dubach, The Anatomy of a Decentralized Prediction Market</a>.</li>
            <li><a href="https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf">Bailey et al., The Probability of Backtest Overfitting</a>.</li>
        </ul>
        <p><strong>Limit:</strong> this is public-wallet research, not proof of identity, private information, causality, or future profit. It is not financial advice.</p>
    </section>
</main>

<footer>
    <div class="page">Polymarket trader investigation &middot; Plain-English edition &middot; Generated from committed evidence</div>
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
