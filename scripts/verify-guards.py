"""Prove each source-scanning guard actually fails when its bug is present.

    python scripts/verify-guards.py

    python scripts/verify-guards.py --ledger

Run the first after touching anything in tests/brand.test.ts or
tests/offline.test.ts. Run `--ledger` after touching FEEDBACK.md or any fix it
anchors: it breaks each tester fix in turn and requires something OTHER than
the ledger's own anchor check to notice. Both take a minute or two — they run
the suite once per case.

Two of today's guards passed vacuously and one was hiding a real bug, so "the
suite is green" is not evidence a guard works. For each: inject a SYNTACTICALLY
VALID violation, run the suite, require it to fail, restore.

The first version of this script was itself wrong in the same way it was built
to catch. Its mutations produced invalid TypeScript, `node --test` died without
printing a summary, and the parser read a missing "fail N" line as zero
failures — so every guard looked vacuous. A missing summary is now a CRASH,
which is a different verdict from a guard that did not fire.
"""
import os
import re
import shutil
import subprocess
import sys

CASES = [
    (
        'yellow text, own line inside a drawText',
        'src/shell/rigcheck.ts',
        "\nfunction __probeYellow(ctx: CanvasRenderingContext2D): void {\n"
        "  drawText(ctx, 'X', 0, 0, {\n"
        "    size: 10,\n"
        "    color: COLORS.yellow,\n"
        "  });\n"
        "}\n",
    ),
    ('css: yellow text', 'src/styles.css', "\n.probe {\n  color: var(--yellow);\n}\n"),
    ('css: muted text', 'src/styles.css', "\n.probe {\n  color: var(--muted);\n}\n"),
    (
        'css: white on white',
        'src/styles.css',
        "\n.probe {\n  background: rgba(255, 255, 255, 0.05);\n}\n",
    ),
    ('css: blur', 'src/styles.css', "\n.probe {\n  backdrop-filter: blur(2px);\n}\n"),
    (
        'offline: absolute URL',
        'src/core/tracker.ts',
        "\nconst __probeUrl = 'https://example.com/x.json';\n",
    ),
    (
        'fitText without spacing',
        'src/shell/rigcheck.ts',
        "\nfunction __probeFit(ctx: CanvasRenderingContext2D): number {\n"
        "  return fitText(ctx, 'X', 100, 10);\n"
        "}\n",
    ),
]

SUMMARY = re.compile(r'fail\s+(\d+)\s*$', re.M)


def run_tests():
    r = subprocess.run(
        'npm test', capture_output=True, text=True, shell=True, cwd=os.getcwd()
    )
    out = r.stdout + r.stderr
    m = SUMMARY.search(out)
    if not m:
        return None  # no summary at all: the runner died
    return int(m.group(1))


def verify_appended():
    baseline = run_tests()
    print('baseline failures:', baseline)
    assert baseline == 0, 'tree is not green to begin with'

    results = []
    for name, path, addition in CASES:
        backup = path + '.guardbak'
        shutil.copyfile(path, backup)
        try:
            with open(path, 'a', encoding='utf-8', newline='') as fh:
                fh.write(addition)
            n = run_tests()
            verdict = 'CRASH' if n is None else ('CAUGHT' if n > 0 else 'VACUOUS')
            results.append((name, verdict, n))
        finally:
            shutil.copyfile(backup, path)
            os.remove(backup)

    print()
    for name, verdict, n in results:
        print(f'{verdict:8s} {str(n):>4s}   {name}')

    bad = [r for r in results if r[1] != 'CAUGHT']
    print('\nNOT CAUGHT:', len(bad))
    return 1 if bad else 0


# ----------------------------------------------------------------------------
# --ledger: is every tester fix ALIVE, or merely still typed into the file?
# ----------------------------------------------------------------------------
#
# `feedback.test.ts` proves each ledger anchor still EXISTS. That is a much
# weaker claim than the fix working: a constant can sit in a file nothing reads
# and the anchor check stays green. This breaks each fix in turn and requires
# something OTHER than that anchor check to notice.
#
# Run on 2026-09-20 it found SIX rows held up by nothing but the ledger text,
# and a seventh — row 20 — whose fix had come back as a live bug for any player
# standing off-centre.
#
# Numeric anchors are mutated automatically. The rest need a hand-written
# change that still COMPILES: deleting an identifier only proves the compiler
# is awake, and a mutation that fails to build is not evidence either way.
# Three of these were silently useless before they were fixed — one set a
# constructor default that the caller always overrides, one left three
# parameters unused, one changed TypeScript's narrowing — and each reported a
# guarded row as unguarded.

ANCHOR_TEST = 'every row names a file that exists and a fix that is still in it'

SEMANTIC = [
    ('4', 'src/games/base.ts',
     "const n = Math.round(tunables.get('vision.poseModel', 1));", 'const n = 0;'),
    ('5', 'src/engine/draw.ts', 'if (shadowColor !== color) {', 'if (true) {'),
    ('6', 'src/games/sixtyseven.ts', '  upEnter: 0.12,', '  upEnter: 0.6,'),
    ('7', 'src/core/gestures.ts', '  centreRate: 0.02,', '  centreRate: 0,'),
    ('8', 'src/core/gestures.ts',
     'const holding = displaced >= this.tun.holdAt && this.heldSec <= this.tun.holdSec;',
     'const holding = false;'),
    ('11', 'src/games/redlight.ts',
     'c.quiet = calibrateQuiet(c.quiet, c.energy, dtv, this.tun);',
     'c.quiet = calibrateQuiet(c.quiet, c.quiet, dtv, this.tun);'),
    ('12', 'src/shell/menu.ts', 'PUMP YOUR ARMS, FREEZE ON RED', 'ZZZZ ZZZZ ZZZZ'),
    ('13', 'src/games/redlight.ts', "'<PUMP>'", "'<ZZZZ>'"),
    ('14', 'src/games/redlight.ts',
     '    if (r.lane !== slot) continue;', '    if (r.lane !== slot && false) continue;'),
    ('15', 'src/games/base.ts',
     'return playerCount === 2 && !partyMode && supportsVersus;',
     'return playerCount >= 2 && !partyMode ? true : supportsVersus;'),
    ('16', 'src/games/base.ts', 'STEP OUT — NEXT PLAYER IN ', 'NEXT PLAYER IN '),
    ('19', 'src/games/balloonpop.ts', 'hudShelf: true,', 'hudShelf: false,'),
    ('21', 'src/games/fruitninja.ts',
     "const CHAIN_WORDS = ['', '', '<DOUBLE!>', '<TRIPLE!>', '<QUAD!>', '<FIVE!>'];",
     'const CHAIN_WORDS: string[] = [];'),
    ('23', 'src/core/tracker.ts', 'minRelativeSize: 0.5,', 'minRelativeSize: 0,'),
    ('24', 'src/shell/menu.ts',
     'if (limit > 0) return live.slice(0, limit);',
     'if (false) return live.slice(0, limit);'),
    ('25', 'src/shell/operator.ts',
     "const addRow = el('div', 'op-entry-row');", "const addRow = el('div', 'op-zzz');"),
    # `return key;` would leave `typed` unused and fail to build, which is not a
    # verdict. `typed < 0` is never true for a count, so SKIP never appears.
    ('26', 'src/shell/initials.ts',
     "return key === 'OK' && typed === 0 ? 'SKIP' : key;",
     "return key === 'OK' && typed < 0 ? 'SKIP' : key;"),
    ('27', 'src/shell/hover.ts',
     '    pointer.clickPending = click.pending;', '    void click;'),
]

FAILING = re.compile(r'✖ (.+?) \(\d+(?:\.\d+)?ms\)')
NUM = re.compile(r'(-?\d+\.?\d*)')


def failing_tests():
    # `encoding='utf-8'` is LOAD-BEARING on Windows. Without it subprocess
    # decodes with the locale codepage (cp1252 here), the test runner's heavy
    # ballot X is mangled, and this returns an empty set for every mutation —
    # reporting all 27 rows as unguarded when they are fine. `run_tests` above
    # gets away with it only because it matches an ASCII summary line.
    r = subprocess.run(
        'npm test', capture_output=True, text=True, shell=True, cwd=os.getcwd(),
        encoding='utf-8', errors='replace'
    )
    out = (r.stdout or '') + (r.stderr or '')
    tail = out.split('failing tests:', 1)
    if len(tail) < 2:
        return set()
    return {m.group(1).strip() for m in FAILING.finditer(tail[1])}


def typechecks():
    r = subprocess.run(
        'npx tsc --noEmit', capture_output=True, text=True, shell=True, cwd=os.getcwd(),
        encoding='utf-8', errors='replace'
    )
    return r.returncode == 0


def ledger_rows():
    """Row number, report, and every `file` + `snippet` pair, in order."""
    with open('FEEDBACK.md', encoding='utf-8') as fh:
        md = fh.read()
    body = md.split('## The ledger', 1)[1].split('\n## ', 1)[0]
    rows = []
    for line in body.split('\n'):
        if not line.startswith('| '):
            continue
        cells = [c.strip() for c in line.split('|')[1:-1]]
        if len(cells) < 4 or cells[0] == '#' or set(cells[0]) <= set('-: '):
            continue
        toks = re.findall(r'`([^`]+)`', cells[3])
        pairs, cur = [], None
        for t in toks:
            if '/' in t and t.endswith('.ts'):
                cur = t
            elif cur:
                pairs.append((cur, t))
        rows.append((cells[0], cells[1][:52], pairs))
    return rows


def numeric_mutation(snippet):
    """Change the last number in an anchor to something clearly different."""
    found = list(NUM.finditer(snippet))
    if not found:
        return None
    m = found[-1]
    try:
        val = float(m.group(1))
    except ValueError:
        return None
    new = val * 2 + 1
    txt = ('%.4f' % new).rstrip('0').rstrip('.') if '.' in m.group(1) else str(int(new))
    return snippet[: m.start(1)] + txt + snippet[m.end(1):]


def verify_ledger():
    if failing_tests():
        print('tree is not green to begin with')
        return 1

    semantic = {r[0]: r[1:] for r in SEMANTIC}
    verdicts = []

    for num, report, pairs in ledger_rows():
        case = None
        if num in semantic:
            path, find, repl = semantic[num]
        else:
            for path, snippet in pairs:
                mutant = numeric_mutation(snippet)
                if mutant is not None:
                    find, repl = snippet, mutant
                    break
            else:
                verdicts.append((num, report, 'NOCASE', ''))
                continue

        with open(path, encoding='utf-8') as fh:
            src = fh.read()
        if find not in src:
            verdicts.append((num, report, 'STALE', path))
            continue

        with open(path, 'w', encoding='utf-8', newline='') as fh:
            fh.write(src.replace(find, repl))
        try:
            ok = typechecks()
            failed = failing_tests() if ok else set()
        finally:
            with open(path, 'w', encoding='utf-8', newline='') as fh:
                fh.write(src)

        if not ok:
            verdicts.append((num, report, 'NOCOMP', find[:46]))
            continue
        others = sorted(f for f in failed if ANCHOR_TEST not in f)
        verdicts.append((num, report, 'ALIVE' if others else 'ANCHOR',
                         '; '.join(others[:2]) or 'only the ledger anchor check'))

    print()
    for num, report, verdict, detail in verdicts:
        print(f'row {num:>3s}  {verdict:7s} {report:<54s} {detail}')

    bad = [v for v in verdicts if v[2] != 'ALIVE']
    print(f'\nrows: {len(verdicts)}   not alive: {len(bad)}')
    if bad:
        print('\nA row that is not ALIVE has no test that fails when its fix is undone.')
        print('NOCOMP means the mutation did not build, which is not a verdict either way.')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(verify_ledger() if '--ledger' in sys.argv else verify_appended())
