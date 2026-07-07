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

import { useEffect, useRef, useState, type RefObject } from "react";
import { ExternalLink, Copy, Check } from "lucide-react";
import { REVX_URL, CLI_COMMAND } from "./config.ts";
import { addUserActionBreadcrumb } from "./lib/telemetry";
import { handleExternalClick } from "./utils/externalNavigation";

type Props = {
  domain: string;
  moddable: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
};

export default function ModPopup({ domain, moddable, onClose, anchorRef }: Props) {
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);
  const slug = domain.replace(/\.dot$/, "");
  const modCmd = `${CLI_COMMAND} mod ${slug}`;
  const revxHref = `${REVX_URL}/editor?mod=${encodeURIComponent(domain)}`;

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popupRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchorRef, onClose]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(modCmd);
    addUserActionBreadcrumb("Copy mod command", { domain });
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div
      ref={popupRef}
      className="popup popup-mod is-open"
      onClick={e => e.stopPropagation()}
      data-testid="mod-popup"
    >
      <div className="popup-body">
        <p>
          {moddable
            ? `Mod this app. Open it in RevX in the browser, or clone it locally with the ${CLI_COMMAND} CLI.`
            : "This app is play-only; its source isn't published, so it can't be modded."}
        </p>
        {moddable && (
          <>
            <a
              className="popup-cta"
              href={revxHref}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => {
                addUserActionBreadcrumb("Vibe Code in RevX", { domain });
                handleExternalClick(e);
              }}
              data-testid="popup-revx-link"
            >
              <ExternalLink size={14} aria-hidden="true" />
              Vibe Code in RevX
            </a>
            <div className="popup-or" aria-hidden="true">or</div>
            <div className="popup-cli">
              <code>{modCmd}</code>
              <button
                type="button"
                className="popup-copy"
                onClick={handleCopy}
                aria-label="Copy command"
                data-testid="popup-copy-btn"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
