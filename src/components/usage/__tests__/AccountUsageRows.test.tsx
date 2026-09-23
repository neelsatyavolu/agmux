import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AccountUsageRows } from "../AccountUsageRows";
import type { ProviderAccount } from "../../../lib/providerAccounts";
const base: ProviderAccount = { id:"a",provider:"codex",label:"Work",enabled:true,priority:0,teamId:null,status:"ready",remainingPercent:60,resetsAt:null,lastCheckedAt:Date.now()/1000,error:null };
afterEach(cleanup);
describe("account usage limits", () => {
  it("renders only reported Claude sub-windows with their own labels", () => {
    render(<AccountUsageRows accounts={[{...base,provider:"claude",usage:{
      session:null, weekly:null,
      sonnet:{utilization:15,resetsAt:null,windowMinutes:10080},
      opus:{utilization:35,resetsAt:null,windowMinutes:10080},
      design:{utilization:55,resetsAt:null,windowMinutes:10080},
      routines:{utilization:75,resetsAt:null,windowMinutes:10080},
    }}]} teams={[]} />);
    for (const [label, remaining] of [["Sonnet",85],["Opus",65],["Designs",45],["Routines",25]] as const) {
      expect(screen.getByRole("progressbar", { name: `Work Personal ${label} remaining` }).getAttribute("aria-valuenow")).toBe(String(remaining));
    }
    expect(screen.getAllByRole("progressbar")).toHaveLength(4);
    expect(screen.queryByText("Session")).toBeNull();
    expect(screen.queryByText("Weekly")).toBeNull();
    expect(screen.queryByText("60% left")).toBeNull();
  });
  it("does not invent missing Claude sub-windows or show them for other providers", () => {
    const { rerender } = render(<AccountUsageRows accounts={[{...base,provider:"claude",usage:{session:null,weekly:null,sonnet:null}}]} teams={[]} />);
    for (const label of ["Sonnet","Opus","Designs","Routines"]) expect(screen.queryByText(label)).toBeNull();
    rerender(<AccountUsageRows accounts={[{...base,usage:{session:null,weekly:null,sonnet:{utilization:15,resetsAt:null,windowMinutes:10080}}}]} teams={[]} />);
    expect(screen.queryByText("Sonnet")).toBeNull();
  });
  it("keeps Claude sub-window invalid and elapsed readings unavailable", () => {
    render(<AccountUsageRows accounts={[{...base,provider:"claude",usage:{session:null,weekly:null,
      sonnet:{utilization:NaN,resetsAt:null,windowMinutes:10080}, opus:{utilization:0,resetsAt:"1",windowMinutes:10080},
    }}]} teams={[]} stale />);
    expect(screen.getByText("Usage unavailable")).toBeTruthy();
    expect(screen.getByText("Awaiting refresh")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText("Last known usage")).toBeTruthy();
  });
  it("never presents Claude as a team account", () => {
    render(<AccountUsageRows accounts={[{...base,provider:"claude",teamId:"t"}]} teams={[]} />);
    expect(screen.queryByRole("article")).toBeNull();
  });
  it.each(["Free", "Plus", "Pro 5x", "Pro 20x", "Pro (tier unavailable)"])("shows native current login metadata and the backend plan %s", plan => {
    render(<AccountUsageRows accounts={[{...base,native:true,currentLogin:true,email:"me@example.com",plan}]} teams={[]} />);
    expect(screen.getByText("Current login")).toBeTruthy();
    expect(screen.getByText("me@example.com")).toBeTruthy();
    expect(screen.getByText(plan)).toBeTruthy();
    expect(screen.getByText("60% left")).toBeTruthy();
  });
  it("honors managed current login flags without duplicating or merging supplied rows", () => {
    render(<AccountUsageRows accounts={[
      {...base,native:false,currentLogin:true,enabled:false,email:"me@example.com"},
      {...base,id:"other",label:"Other",email:"me@example.com"},
    ]} teams={[]} />);
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.getAllByText("Current login")).toHaveLength(1);
    expect(screen.getByText("Paused")).toBeTruthy();
  });
  it("omits duplicate email and absent metadata", () => {
    render(<AccountUsageRows accounts={[{...base,label:"Me@example.com",email:"me@example.com",plan:null}]} teams={[]} />);
    expect(screen.getAllByText(/me@example.com/i)).toHaveLength(1);
    expect(screen.queryByText("Current login")).toBeNull();
  });
  it("shows every account and distinguishes personal from team accounts", () => {
    render(<AccountUsageRows accounts={[base,{...base,id:"b",teamId:"team",remainingPercent:20}]} teams={[{id:"team",name:"Studio",role:"employee",canManage:false}]} />);
    expect(screen.getAllByText("Work")).toHaveLength(2);
    expect(screen.getByText("Personal")).toBeTruthy();
    expect(screen.getByText("Studio")).toBeTruthy();
    expect(screen.getByText("60% left")).toBeTruthy();
    expect(screen.getByText("20% left")).toBeTruthy();
  });
  it("renders each reported window with remaining rather than used percentage", () => {
    render(<AccountUsageRows accounts={[{...base,usage:{session:{utilization:25,resetsAt:null,windowMinutes:300},weekly:{utilization:80,resetsAt:null,windowMinutes:10080}}}]} teams={[]} />);
    expect(screen.getByText("5-hour")).toBeTruthy(); expect(screen.getByText("Weekly")).toBeTruthy();
    expect(screen.getByText("75% left")).toBeTruthy(); expect(screen.getByText("20% left")).toBeTruthy();
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
  });
  it("does not invent empty windows or usage for unknown team limits", () => {
    render(<AccountUsageRows accounts={[{...base,teamId:"t",remainingPercent:null}]} teams={[]} />);
    expect(screen.getByText("Usage unavailable")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText("5-hour")).toBeNull();
  });
  it("marks stale cached readings and never treats an elapsed reset as full capacity", () => {
    render(<AccountUsageRows accounts={[{...base,enabled:false,resetsAt:1}]} teams={[]} stale />);
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByText("Last known usage")).toBeTruthy();
    expect(screen.getByText("Awaiting refresh")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});
