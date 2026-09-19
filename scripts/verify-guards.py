"""Prove each source-scanning guard actually fails when its bug is present.

    python scripts/verify-guards.py

Run it after touching anything in tests/brand.test.ts or tests/offline.test.ts.
Takes about a minute — it runs the suite once per case.

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
sys.exit(1 if bad else 0)
