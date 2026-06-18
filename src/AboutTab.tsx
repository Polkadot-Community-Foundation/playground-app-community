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

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Link } from "react-router-dom";
import CodeSnippet from "./CodeSnippet";
import SiteFooter from "./SiteFooter";
import { handleExternalClick } from "./utils/externalNavigation";
import { CLI_COMMAND, INSTALL_CMD } from "./config";
import { CheckIcon, CopyIcon } from "./icons";
import { useScrambleText } from "./useScrambleText";

type CliRow = {
  id: string;
  cmd: string;
  desc: string;
  hue: string;
  action?:
    | { kind: "copy"; label: string }
    | { kind: "link"; label: string; to: string };
};

const DEFAULT_HERO = "A playground for sovereign apps";

const CLI_ROWS: CliRow[] = [
  {
    id: "install",
    cmd: INSTALL_CMD,
    desc: DEFAULT_HERO,
    hue: "defi",
    action: { kind: "copy", label: "Install CLI ↵" },
  },
  {
    id: "login",
    cmd: `${CLI_COMMAND} login`,
    desc: "Set up your toolchain, phone signing, and funded testnet account.",
    hue: "gaming",
  },
  {
    id: "mod",
    cmd: `${CLI_COMMAND} mod <url>`,
    desc: "Pull the source code of an already published app to inspect and mod.",
    hue: "social",
    action: { kind: "link", label: "Explore Moddable Apps ↵", to: "/apps" },
  },
  {
    id: "deploy",
    cmd: `${CLI_COMMAND} deploy`,
    desc: "Ship frontend, backend and domain to decentralised infrastructure in one pass.",
    hue: "irl",
  },
];

const IDEAS: Array<{ title: string; desc: string }> = [
  {
    title: "A personal site on a .dot domain",
    desc: "Static page hosted on Bulletin, owned by your account.",
  },
  {
    title: "A leaderboard for any game",
    desc: "Plug a high-score contract into a clicker, a snake clone, anything.",
  },
  {
    title: "A private chat with an agent",
    desc: "Statement Store on the web side, AI agent on the CLI side.",
  },
  {
    title: "A polling or signing tool",
    desc: "PoP-gated votes, attributable statements, lightweight governance.",
  },
  {
    title: "A shared canvas or notepad",
    desc: "Multiple accounts writing to the same Bulletin-backed document.",
  },
  {
    title: "Sky is the limit",
    desc: "The point of a playground is that you're allowed to.",
  },
];

/**
 * About tab — the general explanatory content that used to live at the top of
 * the Playground tab (everything except the hero island, the XP block, and the
 * footer). The Playground tab is now the task / XP / prizes journey.
 */
export default function AboutTab() {
  return (
    <section className="tab tab-playground tab-about" data-testid="tab-about">
      <section className="row row-hero row-hero-intro">
        <h1 className="display">
          Build something on Polkadot
          <br />
          <em>in about thirty minutes.</em>
        </h1>
        <p className="lead">
          Modify any app, then publish it live on a .dot domain.
          <br />
          <br />
          It's open source on a new level: not just code you can read, but
          actually deployed apps you can inspect. Turn published apps into new
          ideas, inspire others, and build a transparent developer reputation as
          you ship.
        </p>
      </section>

      <FlowRow />

      <CliSection />

      <section className="row gs-section">
        <p className="gs-section-lead">
          No landlord, no jury, no takedown.
          <br />
          Build apps that don't rent their backend.
          <br />
          Mod a sample app whose shape is close to your idea.
          <br />
        </p>
        <ul className="idea-list">
          {IDEAS.map((idea) => (
            <li key={idea.title} className="idea-item">
              <span className="idea-dot" aria-hidden="true" />
              <div>
                <p className="idea-title">{idea.title}</p>
                <p className="idea-desc">{idea.desc}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="row row-pitch">
        <article className="card card-pitch">
          <div className="pitch-art" data-hue="social" aria-hidden="true">
            <span className="pitch-art-emoji">👥</span>
          </div>
          <div className="pitch-meta">
            <h3 className="pitch-title">
              Built for humans,
              <br />
              not the funnel.
            </h3>
            <p className="pitch-lead">
              Your app opens inside the <strong>Polkadot App</strong>, where the
              people already are.
            </p>
          </div>
        </article>

        <article className="card card-pitch">
          <div className="pitch-art" data-hue="defi" aria-hidden="true">
            <span className="pitch-art-emoji">🚀</span>
          </div>
          <div className="pitch-meta">
            <h3 className="pitch-title">
              Thirty minutes,
              <br />
              idea to live.
            </h3>
            <p className="pitch-lead">
              <Link className="pitch-link" to="/apps">
                Pick a template
              </Link>
              . Mod with AI. Deploy on chain. No boilerplate, no infra, no
              waiting on your CI.
            </p>
          </div>
        </article>

        <article className="card card-pitch">
          <div className="pitch-art" data-hue="gaming" aria-hidden="true">
            <span className="pitch-art-emoji">☁️</span>
          </div>
          <div className="pitch-meta">
            <h3 className="pitch-title">Nothing to host.</h3>
            <p className="pitch-lead">
              Frontend and domain on{" "}
              <a
                className="pitch-link"
                href="https://docs.polkadot.com/apps"
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleExternalClick}
              >
                Bulletin &amp; DotNS
              </a>
              . State on chain.
            </p>
          </div>
        </article>

        <article className="card card-pitch">
          <div className="pitch-art" data-hue="irl" aria-hidden="true">
            <span className="pitch-art-emoji">🛡️</span>
          </div>
          <div className="pitch-meta">
            <h3 className="pitch-title">No off switch.</h3>
            <p className="pitch-lead">
              Once it's deployed, nobody can take it down. Not the platform. Not
              the lawyers. Only you.
            </p>
          </div>
        </article>
      </section>

      <SiteFooter />
    </section>
  );
}

function FlowRow() {
  const steps: Array<{
    num: string;
    title: string;
    cmd: string;
    hue: string;
  }> = [
    {
      num: "01",
      title: `Install ${CLI_COMMAND} CLI and get ready to build`,
      cmd: INSTALL_CMD,
      hue: "defi",
    },
    {
      num: "02",
      title: "Login with Polkadot App",
      cmd: `${CLI_COMMAND} login`,
      hue: "gaming",
    },
    {
      num: "03",
      title: "Learn how to build a games with AI guidance",
      cmd: `${CLI_COMMAND} mod rock-paper-scissors42.dot`,
      hue: "social",
    },
    {
      num: "04",
      title: "Go live on .dot",
      cmd: `${CLI_COMMAND} deploy --playground`,
      hue: "irl",
    },
  ];

  return (
    <section className="row-flow-wrap">
      <h2 className="row-flow-heading">Simple steps to get started</h2>
      <section className="row row-flow">
        {steps.map((s) => (
          <article key={s.num} className="flow-step" data-hue={s.hue}>
            <div className="flow-step-head">
              <span className="flow-num">{s.num}</span>
              <span className="ucard-title">{s.title}</span>
            </div>
            <CodeSnippet command={s.cmd} />
          </article>
        ))}
      </section>
    </section>
  );
}

function CliSection() {
  const [activeId, setActiveId] = useState<string>("install");
  const sectionRef = useRef<HTMLElement | null>(null);
  const heroRef = useRef<HTMLHeadingElement | null>(null);
  const itemRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const [installCopied, setInstallCopied] = useState(false);

  const active = CLI_ROWS.find((r) => r.id === activeId) ?? CLI_ROWS[0];
  useScrambleText(active.desc, heroRef);

  // When the CLI section scrolls out of view, reset to default row.
  useEffect(() => {
    const node = sectionRef.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) setActiveId("install");
        }
      },
      { threshold: 0 },
    );
    io.observe(node);
    return () => io.disconnect();
  }, []);

  const copyInstall = useCallback(() => {
    navigator.clipboard.writeText(INSTALL_CMD);
    setInstallCopied(true);
    setTimeout(() => setInstallCopied(false), 2000);
  }, []);

  const onListKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const idx = CLI_ROWS.findIndex((r) => r.id === activeId);
      const next =
        e.key === "ArrowDown"
          ? CLI_ROWS[(idx + 1) % CLI_ROWS.length]
          : CLI_ROWS[(idx - 1 + CLI_ROWS.length) % CLI_ROWS.length];
      setActiveId(next.id);
      itemRefs.current.get(next.id)?.focus();
    } else if (e.key === "Enter") {
      const row = CLI_ROWS.find((r) => r.id === activeId);
      if (row?.action?.kind === "copy") {
        e.preventDefault();
        copyInstall();
      }
    }
  };

  return (
    <section
      ref={sectionRef}
      className="row row-cli"
      aria-label={`${CLI_COMMAND} CLI commands`}
    >
      <article className="card card-cli">
        <ul
          className="cli-commands"
          role="listbox"
          aria-label={`${CLI_COMMAND} CLI commands`}
          onKeyDown={onListKeyDown}
        >
          {CLI_ROWS.map((row) => (
            <li
              key={row.id}
              ref={(el) => {
                if (el) itemRefs.current.set(row.id, el);
                else itemRefs.current.delete(row.id);
              }}
              tabIndex={0}
              role="option"
              aria-selected={row.id === activeId}
              data-hue={row.hue}
              className={`cli-row${row.id === activeId ? " is-active" : ""}`}
              onMouseEnter={() => setActiveId(row.id)}
              onFocus={() => setActiveId(row.id)}
            >
              <span className="cli-cmd">{row.cmd}</span>
              {row.action?.kind === "copy" && (
                <button
                  type="button"
                  className="cli-action"
                  onClick={(e) => {
                    e.stopPropagation();
                    copyInstall();
                  }}
                  aria-label="Copy install command"
                >
                  {installCopied ? <CheckIcon /> : <CopyIcon />}{" "}
                  {installCopied ? "Copied" : row.action.label}
                </button>
              )}
              {row.action?.kind === "link" && (
                <Link
                  className="cli-action"
                  to={row.action.to}
                  onClick={(e) => e.stopPropagation()}
                >
                  {row.action.label}
                </Link>
              )}
            </li>
          ))}
        </ul>
      </article>

      <section className="row row-hero row-hero-reactive">
        <h1 ref={heroRef} className="display" id="hero-title">
          {DEFAULT_HERO}
        </h1>
      </section>
    </section>
  );
}
