// Copyright (C) Parity Technologies (UK) Ltd.
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

interface Props {
  message: string;
  title?: string;
  onRetry?: () => void;
  compact?: boolean;
  testid?: string;
}

export default function ErrorBanner({ message, title, onRetry, compact, testid }: Props) {
  const className = compact ? "error-banner error-banner-compact" : "error-banner";
  return (
    <div className={className} data-testid={testid} role="alert">
      {title && <strong>{title}</strong>}
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="error-banner-retry" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
