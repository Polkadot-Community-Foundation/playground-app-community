#!/usr/bin/env bash
# Verify (or add) the GPL-3.0-or-later SPDX header on every tracked source file.
#
# Usage:
#   scripts/check-license-headers.sh         # check (CI). Exits non-zero if any file is missing the header.
#   scripts/check-license-headers.sh --fix   # prepend the header to any source file missing it.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

HEADER='// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
'

# git ls-files honors .gitignore, so dist/, target/, node_modules/, .cdm/ are skipped.
mode="${1:-check}"
missing=()
total=0

while IFS= read -r f; do
  total=$((total + 1))
  # Require BOTH the SPDX line and the Parity copyright line. A bare SPDX line
  # alone is not enough — we want the full Parity-style block, not just the
  # machine-readable identifier.
  if ! grep -q 'SPDX-License-Identifier: GPL-3.0-or-later' "$f" \
     || ! grep -q 'Copyright (C) Parity Technologies' "$f"; then
    missing+=("$f")
  fi
done < <(git ls-files '*.ts' '*.tsx' '*.rs')

if [[ ${#missing[@]} -eq 0 ]]; then
  echo "All ${total} source files have the GPL-3.0-or-later SPDX header."
  exit 0
fi

if [[ "$mode" == "--fix" ]]; then
  for f in "${missing[@]}"; do
    { printf '%s\n' "$HEADER"; cat "$f"; } > "$f.tmp"
    mv "$f.tmp" "$f"
    echo "fixed: $f"
  done
  exit 0
fi

echo "Missing GPL-3.0-or-later SPDX header in ${#missing[@]} file(s):"
printf '  %s\n' "${missing[@]}"
echo
echo "Run 'scripts/check-license-headers.sh --fix' to add the header automatically."
exit 1
