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

import { useState } from "react";
import { CheckIcon, CopyIcon, SparkleIcon } from "./icons";

type Props = {
  command: string;
  ariaLabel?: string;
  variant?: "command" | "prompt";
};

export default function CodeSnippet({ command, ariaLabel, variant = "command" }: Props) {
  const [copied, setCopied] = useState(false);
  const isPrompt = variant === "prompt";

  const handleCopy = () => {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const noun = isPrompt ? "prompt" : "command";

  return (
    <div className={`code-snippet${isPrompt ? " is-prompt" : ""}${copied ? " is-copied" : ""}`}>
      {isPrompt ? (
        <SparkleIcon className="code-prompt-icon" aria-hidden="true" />
      ) : (
        <span className="code-prompt" aria-hidden="true">$</span>
      )}
      <p className="code-cmd" aria-label={`${isPrompt ? "Prompt" : "Command"}: ${command}`}>
        {command}
      </p>
      <button
        type="button"
        className="code-copy"
        onClick={handleCopy}
        aria-label={ariaLabel ?? `Copy ${noun}: ${command}`}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
}
