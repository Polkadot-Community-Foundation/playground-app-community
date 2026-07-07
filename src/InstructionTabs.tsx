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

import { useId, useState, type ReactNode } from "react";
import { Globe, LaptopMinimal, Monitor, Smartphone } from "lucide-react";
import { detectEnvironment, type Environment } from "./utils/environment";

type Props = {
  /** Local CLI flow — instructions for working on your computer. */
  desktop: ReactNode;
  /** In-browser flow — Site Builder / RevX. */
  web: ReactNode;
  /**
   * Phone flow. Omit when the step can't be done on a phone — the Mobile tab
   * then explains that a computer is needed to complete the quest.
   */
  mobile?: ReactNode;
};

const TAB_META: { key: Environment; label: string; icon: ReactNode }[] = [
  { key: "desktop", label: "Desktop", icon: <Monitor size={24} aria-hidden="true" /> },
  { key: "web", label: "Web", icon: <Globe size={24} aria-hidden="true" /> },
  { key: "mobile", label: "Mobile", icon: <Smartphone size={24} aria-hidden="true" /> },
];

/**
 * Three-mode instruction switcher keyed on where the user is working —
 * Desktop / Web / Mobile. The default tab is auto-detected (see
 * detectEnvironment) but every tab stays manually selectable. When a step has
 * no mobile path the Mobile tab explains a computer is needed.
 */
export default function InstructionTabs({ desktop, web, mobile }: Props) {
  // One-shot default — the user's manual choice should survive viewport
  // changes, so this is seeded once and never re-detected.
  const [active, setActive] = useState<Environment>(() => detectEnvironment());
  const baseId = useId();

  const panels: Record<Environment, ReactNode> = {
    desktop,
    web,
    mobile: mobile ?? <ComputerNeededNotice />,
  };

  return (
    <div className="instr-tabs">
      <div className="instr-tablist" role="tablist" aria-label="Instructions">
        {TAB_META.map(({ key, label, icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`${baseId}-${key}-tab`}
            aria-selected={active === key}
            aria-controls={`${baseId}-${key}-panel`}
            className={`instr-tab${active === key ? " is-active" : ""}`}
            onClick={() => setActive(key)}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>

      <div className="instr-box">
        {TAB_META.map(({ key }) => (
          <div
            key={key}
            role="tabpanel"
            id={`${baseId}-${key}-panel`}
            aria-labelledby={`${baseId}-${key}-tab`}
            hidden={active !== key}
            className="instr-panel"
          >
            {panels[key]}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Mobile-tab content for steps that can't be completed on a phone. */
function ComputerNeededNotice() {
  return (
    <p className="instr-computer-needed">
      <LaptopMinimal size={18} aria-hidden="true" />
      You’ll need the help of a computer to complete this quest.
    </p>
  );
}
