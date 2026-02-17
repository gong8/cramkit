#!/usr/bin/env bash
# Count lines of code by package, excluding generated/vendor files

total=0

for pkg in packages/*/; do
	name=$(basename "$pkg")
	count=$(find "$pkg" -type f \( -name "*.ts" -o -name "*.tsx" \) \
		! -path "*/node_modules/*" \
		! -path "*/dist/*" \
		! -path "*generated*" \
		| xargs cat 2>/dev/null | wc -l | tr -d ' ')
	total=$((total + count))
	printf "  %-12s %'6d lines\n" "$name" "$count"
done

echo "  ─────────────────────"
printf "  %-12s %'6d lines\n" "total" "$total"
