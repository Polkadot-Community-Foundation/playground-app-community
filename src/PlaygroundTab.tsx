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

import { Laptop, Square } from "lucide-react";
import { Link } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import CliInstallInstructions from "./CliInstallInstructions";
import CodeSnippet from "./CodeSnippet";
import InstructionTabs from "./InstructionTabs";
import IslandPortal from "./IslandPortal";
import PreHero, { hasSeenPreHero } from "./PreHero";
import JourneySection from "./JourneySection";
import PlaygroundToc from "./PlaygroundToc";
import { QUEST_COLORS } from "./questPalette";
import { XP_VALUES } from "./xpValues";
import SiteFooter from "./SiteFooter";
import XpPrizesSection from "./XpPrizesSection";
import { handleExternalClick } from "./utils/externalNavigation";
import { useOnboarding } from "./OnboardingProvider";
import { scrollToSection, useTaskProgress, useUnlockExpand } from "./utils";
import { CLI_COMMAND, DOCS_URL, REVX_URL, TUTORIAL_DOMAIN } from "./config";

const TUTORIAL_SLUG = TUTORIAL_DOMAIN.replace(/\.dot$/, "");
const TUTORIAL_REVX_URL = `${REVX_URL}/editor?mod=${encodeURIComponent(TUTORIAL_DOMAIN)}`;
const AGENT_PROMPT = "Walk me through the tutorial in this repo.";

/**
 * Playground tab — the task / XP / prizes journey. The hero island sits at the
 * top, the XP & Prizes card is the first text, then each journey step, with a
 * sticky table of contents on the right. Cross-route deep links (the
 * Leaderboard's "How XP & Prizes work" link) arrive as `?section=<id>` and are
 * scrolled into view on mount.
 */
interface PlaygroundTabProps {
  /** H160 of the connected account, or undefined when not signed in. */
  account?: string;
  /** Bumped on point-award events so the island XP total re-fetches live. */
  pointsRefresh: number;
}

export default function PlaygroundTab({ account, pointsRefresh }: PlaygroundTabProps) {
  // Per-task completion (seeded synchronously from the last-known snapshot —
  // checks and collapsed cards are correct on the first frame; chain reads
  // reconcile in the background). Detection-only — no manual self-attest.
  const { tasks } = useTaskProgress(account, {
    pointsRefresh,
    connectedAccount: account,
  });

  // Becoming a builder is the unlock gate: until the user is one, every step
  // after "Become a builder" is locked. `startBecomeBuilder` opens the
  // one-approval onboarding modal (identity + resources, bundled).
  const { hasIdentity, startBecomeBuilder } = useOnboarding();

  // When the build gate first opens, auto-expand the gated steps the user
  // hasn't finished yet — completed steps stay folded. Runs once per device;
  // a later manual collapse is then respected (see useUnlockExpand).
  const expandOnUnlock = useMemo(
    () =>
      (
        [
          ["dot-site", tasks.deploy],
          ["tutorial", tasks.tutorial],
          ["mod", tasks.mod],
          ["get-modded", tasks.mod_received],
          ["stars", tasks.star_received],
        ] as const
      )
        .filter(([, complete]) => !complete)
        .map(([id]) => id),
    [tasks.deploy, tasks.tutorial, tasks.mod, tasks.mod_received, tasks.star_received],
  );
  useUnlockExpand(hasIdentity, expandOnUnlock);

  // First-visit-per-device intro shown above the island. Decided once,
  // synchronously, so the first frame is correct — returning visitors never
  // see a flash of it.
  const [showPreHero] = useState(() => !hasSeenPreHero());

  // Mount-only: honour the `?section=<id>` cross-route deep link (e.g. the
  // Leaderboard's "How XP & Prizes work" link navigates to a fresh
  // `/?section=xp-prizes`). Same-page jumps (quest CTAs, TOC) scroll
  // imperatively via scrollToSection, so they don't rely on this effect.
  useEffect(() => {
    const section = new URLSearchParams(window.location.search).get("section");
    if (section) scrollToSection(section);
  }, []);

  return (
    <section
      className={`tab tab-playground tab-playground-journey${
        showPreHero ? " tab-playground--intro" : ""
      }`}
      data-testid="tab-playground"
    >
      {showPreHero && <PreHero />}

      <IslandPortal
        account={account}
        pointsRefresh={pointsRefresh}
        pinOnScroll={showPreHero}
      />

      <div className="playground-layout">
        <div className="tab-center playground-main">
          <XpPrizesSection />

          <h2 id="earn-xp" className="journey-group-title">Earn XP</h2>

          {/*
            `hue` per section is chosen to MATCH the island portal's accent for the
            same quest (IslandPortal.tsx QUESTS, traced by `anchor`). The QUEST_COLORS
            key names no longer describe their content — the quests were resequenced
            independently of the artwork — so e.g. the `stars` section uses
            QUEST_COLORS.lights. Match the island color, not the key's literal name.
          */}
          <JourneySection
            id="username"
            title="Become a builder"
            hue={QUEST_COLORS.character}
            rewards={[{ amount: XP_VALUES.identity, condition: "when you become a builder" }]}
            lede="Get set up to build on Polkadot."
            description="One quick approval sets you up to publish, star, and mod. Nothing to buy. Your verified name shows up on your apps, stars, mods, and the leaderboard."
            cta={{
              // Not a builder yet → "Become a builder" (the one bundled
              // approval). Once a builder, the CTA falls back to the repeatable
              // "Collect more resources" top-up flow.
              label: !hasIdentity ? "Become a builder" : "Collect more resources",
              onClick: () => startBecomeBuilder(),
            }}
            complete={tasks.username}
          />

          <JourneySection
            id="dot-site"
            title="Launch a .dot site"
            hue={QUEST_COLORS.star}
            rewards={[
              {
                amount: XP_VALUES.deploy,
                condition: "for each of your first three deploys, once it's listed in Apps",
              },
            ]}
            lede="Create your first site on a .dot domain. Start from a static page, publish it to our decentralised network, and make it part of the Playground."
            cta={{ label: "Open Site Builder", to: "/builder" }}
            complete={tasks.deploy}
            gated={!hasIdentity}
          >
            <InstructionTabs
              desktop={
                <>
                  <CliInstallInstructions />
                  <p className="journey-section-desc">
                    You’ve got two options:
                  </p>
                  <ol className="journey-steps">
                    <li>
                      <strong>Build a new site.</strong> In the Site Builder,
                      pick a starting point, customise the page, then hit deploy
                      to publish it to a .dot domain. No local setup needed.
                    </li>
                    <li>
                      <strong>Decentralise an existing site.</strong> Already
                      have a static website? Put it on a .dot domain with the
                      CLI.
                      <CodeSnippet command={`${CLI_COMMAND} decentralize`} />
                    </li>
                  </ol>
                </>
              }
              web={
                <ol className="journey-steps">
                  <li>
                    Pick a starting point in the Site Builder and customize the
                    page.
                  </li>
                  <li>
                    Hit deploy to publish your site to a .dot domain. No local
                    setup needed.
                  </li>
                </ol>
              }
              mobile={
                <ol className="journey-steps">
                  <li>
                    Pick a starting point in the Site Builder and customize the
                    page.
                  </li>
                  <li>
                    Hit deploy to publish your site to a .dot domain, all from
                    your phone.
                  </li>
                </ol>
              }
            />
          </JourneySection>

          {/* Mobile-only divider. On a phone the journey is reordered (CSS
              `order`) so phone-doable quests sit above this line and the
              computer-bound ones (greyed) fall below it. Hidden on desktop,
              where the journey keeps its source order. */}
          <div className="journey-computer-break" aria-hidden="true">
            <Laptop size={15} strokeWidth={2} aria-hidden="true" />
            To complete these quests, you’ll need your computer
            <Laptop size={15} strokeWidth={2} aria-hidden="true" />
          </div>

          <JourneySection
            id="tutorial"
            title="Build a game with our tutorial"
            hue={QUEST_COLORS.gates}
            rewards={[
              { amount: XP_VALUES.deploy, condition: "for each of your first three deploys" },
            ]}
            lede="Build a game app one level at a time, in about thirty minutes."
            complete={tasks.tutorial}
            gated={!hasIdentity}
          >
            <div className="journey-about">
              <ul className="ucard-checklist">
                <li><Square size={16} aria-hidden="true" /> Level 1 – Local Challenger</li>
                <li><Square size={16} aria-hidden="true" /> Level 2 – On-chain Record</li>
                <li><Square size={16} aria-hidden="true" /> Level 3 – The Leaderboard</li>
                <li><Square size={16} aria-hidden="true" /> Level 4 – Multiplayer</li>
              </ul>
              <p className="journey-section-desc">
                Along the way you learn how decentralised storage, unstoppable logic,
                and player-owned assets change what apps are made of.
              </p>
              <p className="journey-section-desc">
                Prefer your own thing? Explore, mod, and deploy any app. Any of
                your first three deploys earns the XP.
              </p>
              <p className="journey-section-desc">
                This tutorial gets you building fast. To go deeper, see the{" "}
                <a
                  className="journey-link"
                  href={DOCS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={handleExternalClick}
                >
                  developer docs
                </a>
                .
              </p>
            </div>
            <InstructionTabs
              desktop={
                <>
                  <CliInstallInstructions />
                  <ol className="journey-steps">
                    <li>Open a new, empty project directory.</li>
                    <li>
                      Pull the tutorial source code.
                      <CodeSnippet command={`${CLI_COMMAND} mod ${TUTORIAL_SLUG}`} />
                    </li>
                    <li>Confirm cloning the source code when prompted.</li>
                    <li>
                      Once cloning is done, start your coding agent in that
                      project directory.
                    </li>
                    <li>
                      Give the coding agent this prompt:
                      <CodeSnippet command={AGENT_PROMPT} variant="prompt" />
                    </li>
                    <li>Follow the agent's instructions.</li>
                    <li>Get your XP on deploying the results.</li>
                  </ol>
                </>
              }
              web={
                <ol className="journey-steps">
                  <li>
                    Open the tutorial in RevX and press the{" "}
                    <strong>Start tutorial</strong> button.
                    <p className="journey-step-aside">
                      <a
                        className="journey-link"
                        href={TUTORIAL_REVX_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={handleExternalClick}
                      >
                        Press Start tutorial in RevX →
                      </a>
                    </p>
                  </li>
                  <li>Follow the agent's instructions.</li>
                  <li>Get your XP on deploying the results.</li>
                </ol>
              }
            />
          </JourneySection>

          <JourneySection
            id="mod"
            title="Mod an app"
            hue={QUEST_COLORS.underground}
            rewards={[
              { amount: XP_VALUES.deploy, condition: "for each of your first three deploys" },
            ]}
            lede="Found an app you like? Make it your own. Playground apps are designed to be modded, so you can launch your vision without starting from scratch."
            cta={{ label: "Explore apps", to: "/apps" }}
            complete={tasks.mod}
            gated={!hasIdentity}
          >
            <InstructionTabs
              desktop={
                <>
                  <CliInstallInstructions />
                  <p className="journey-tab-intro">
                    Hit <strong>Explore apps</strong> below and open one you’d
                    like to build from. Its detail page shows whether it’s
                    moddable.
                  </p>
                  <ol className="journey-steps">
                    <li>
                      Copy the mod command from the app’s detail page:
                      <CodeSnippet command={`${CLI_COMMAND} mod [url]`} />
                    </li>
                    <li>Run it locally, then make your changes.</li>
                    <li>
                      Deploy your version.
                      <CodeSnippet command={`${CLI_COMMAND} deploy`} />
                    </li>
                    <li>
                      When publishing, select:
                      <ul className="journey-substeps">
                        <li>publish to Playground</li>
                        <li>make it moddable</li>
                        <li>link the source</li>
                      </ul>
                      <span className="journey-note">
                        This gives others a starting point and helps you maximise
                        XP.
                      </span>
                    </li>
                  </ol>
                </>
              }
              web={
                <>
                  <p className="journey-tab-intro">
                    You can mod apps directly from your browser using RevX, a
                    fully in-browser editor with a built-in AI agent. Describe
                    the changes you want, vibe-code your vision, and deploy your
                    ideas to the Playground.
                  </p>
                  <ol className="journey-steps">
                    <li>
                      Hit <strong>Explore apps</strong> below and open one you’d
                      like to build from.
                    </li>
                    <li>
                      On its detail page, click <strong>Vibe Code in RevX</strong>{" "}
                      to open your own copy in the editor.
                    </li>
                  </ol>
                  <p className="journey-warning">
                    Apps deployed from RevX aren’t moddable yet. To publish a
                    moddable app, use the CLI flow.
                  </p>
                </>
              }
            />
          </JourneySection>

          <JourneySection
            id="get-modded"
            title="Get your app modded"
            hue={QUEST_COLORS.pet}
            rewards={[
              { amount: XP_VALUES.modReceived, condition: "each time someone mods your app" },
            ]}
            lede="Your app can be someone else's starting point. Get it out there, make sure it's moddable, then invite people to build on it. You earn XP every time someone does."
            cta={{ label: "My Apps →", to: "/profile" }}
            complete={tasks.mod_received}
            gated={!hasIdentity}
          >
            <ol className="journey-steps">
              <li>
                Check your app shows up in the{" "}
                <Link className="journey-link" to="/apps">
                  Apps
                </Link>{" "}
                list so people can find it.
              </li>
              <li>
                Open its detail page and confirm it carries the{" "}
                <strong>Moddable</strong> badge. No badge? Re-deploy with a
                public GitHub repo linked. That’s what makes an app moddable.
              </li>
              <li>
                Grab the share link from the app’s detail page and send it to
                friends, your group chat, or socials.
              </li>
              <li>
                Invite people to mod it. Every builder who starts from your app
                earns you XP.
              </li>
            </ol>
            <p className="journey-note">
              The more useful your app is as a starting point, the more it gets
              modded. A friendly README and a few quest ideas go a long way.
            </p>
          </JourneySection>

          <JourneySection
            id="stars"
            title="Give and receive stars"
            hue={QUEST_COLORS.lights}
            rewards={[
              { amount: XP_VALUES.starReceived, condition: "each time someone stars your app" },
            ]}
            lede="Star apps you like to save them to your favourites and help surface the projects worth celebrating."
            description="Your stars help choose what gets noticed. Starring is one-way and free, and the XP goes to the app's builder."
            cta={{ label: "Explore apps", to: "/apps" }}
            complete={tasks.star_received}
            gated={!hasIdentity}
          />

          <JourneySection
            id="where-next"
            title="Keep climbing"
            lede="Every app you launch, mod, and star earns XP. See how you stack up against other builders, then keep shipping to climb."
            cta={{ label: "Go to leaderboard", to: "/leaderboard" }}
            plain
          >
            <p className="journey-note">
              Want more? Go deeper in the{" "}
              <a
                className="journey-link"
                href={DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleExternalClick}
              >
                developer docs
              </a>
              , or join the community.
            </p>
          </JourneySection>
        </div>

        <aside className="tab-right-rail playground-toc-rail">
          <PlaygroundToc />
        </aside>
      </div>

      <SiteFooter />
    </section>
  );
}
