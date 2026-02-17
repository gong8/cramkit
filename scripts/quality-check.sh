#!/usr/bin/env bash
set -euo pipefail

BANNED_PATTERNS=(
	"as any"
	"@ts-ignore"
	"@ts-expect-error"
	"@ts-nocheck"
	"eslint-disable"
	"biome-ignore"
)

EXCLUDE_DIRS="--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.turbo --exclude-dir=data"

found=0

for pattern in "${BANNED_PATTERNS[@]}"; do
	# shellcheck disable=SC2086
	if results=$(grep -rn --include="*.ts" --include="*.tsx" $EXCLUDE_DIRS "$pattern" .); then
		echo "❌ Found banned pattern: $pattern"
		echo "$results"
		echo ""
		found=1
	fi
done

if [ "$found" -eq 1 ]; then
	echo "Quality check failed. Fix the violations above."
	exit 1
else
	echo "✅ Quality check passed."
fi
