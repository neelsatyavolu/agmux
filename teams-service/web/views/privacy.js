/* 9 · Privacy / disclosure. Public — linked from every disclosure surface. */

import { html, raw } from "../dom.js";
import { disclosureBlock } from "../disclosure.js";

export function privacy({ backHref }) {
  return html`
    <section class="page" style="max-width:960px">
      <div class="phead">
        <div>
          <div class="eyeb">agmux Teams</div>
          <h1 style="margin-top:6px">What your team can see</h1>
          <div class="meta"><span>Plain language. No exceptions buried below.</span></div>
        </div>
        <div class="sp"></div>
        <a class="btn" href="${backHref || "#/teams"}"><i data-lucide="arrow-left"></i>Back</a>
      </div>

      ${raw(disclosureBlock())}

      <div class="g2b">
        <div class="pnl">
          <div class="pnl-h"><h3>How it works</h3></div>
          <div class="pnl-b flags">
            <div class="flag">
              <div class="num">1</div>
              <div>
                <b>The desktop app counts locally.</b>
                <div class="m">
                  agmux already tracks your own usage in the local Usage panel. Nothing changes
                  there.
                </div>
              </div>
            </div>
            <div class="flag">
              <div class="num">2</div>
              <div>
                <b>It uploads aggregates on a schedule.</b>
                <div class="m">
                  Numbers and labels only — the payload has no room for content, because content is
                  never read.
                </div>
              </div>
            </div>
            <div class="flag">
              <div class="num">3</div>
              <div>
                <b>Your team sees named rows.</b>
                <div class="m">
                  Managers compare people, so rows are named. That is the point of the product, and
                  you agreed to it on join.
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="pnl">
          <div class="pnl-h"><h3>Who sees what</h3></div>
          <div class="tbl-scroll">
            <table class="tbl">
              <thead>
                <tr><th>Capability</th><th>Owner</th><th>Manager</th><th>You</th></tr>
              </thead>
              <tbody>
                <tr><td>Your own metrics</td><td>yes</td><td>yes</td><td class="n">yes</td></tr>
                <tr><td>Other members' metrics</td><td>yes</td><td>yes</td><td class="dim">no</td></tr>
                <tr><td>Create / revoke invites</td><td>yes</td><td class="dim">no</td><td class="dim">no</td></tr>
                <tr><td>Change roles, remove members</td><td>yes</td><td class="dim">no</td><td class="dim">no</td></tr>
                <tr><td>Delete team &amp; all data</td><td>yes</td><td class="dim">no</td><td class="dim">no</td></tr>
                <tr><td>Leave the team</td><td class="dim">transfer first</td><td>yes</td><td class="n">yes</td></tr>
              </tbody>
            </table>
          </div>
          <div class="pnl-b" style="padding-top:0">
            <p class="hint">
              Leaving stops uploads immediately. Your historical aggregates stay with the team unless
              the owner deletes the team or removes you.
            </p>
          </div>
        </div>
      </div>
    </section>
  `;
}
