import { app } from "electron";
import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import https from "https";

type Job = Record<string, any>;
type Config = { enabled: boolean; endpoint: string; driverToken: string; driverName: string; };
type State = { sent: string[] };
const dataDir = () => app.getPath("userData");
const historyPath = () => path.join(os.homedir(), ".multi_stop_dispatch_companion", "history.json");
const configPath = () => path.join(dataDir(), "paperwork-config.json");
const statePath = () => path.join(dataDir(), "paperwork-sent.json");
const defaults: Config = { enabled: false, endpoint: "", driverToken: "", driverName: "" };
let timer: NodeJS.Timeout | undefined;
let busy = false;

function readJson<T>(file: string, fallback: T): T {
    try { return JSON.parse(readFileSync(file, "utf8")) as T; }
    catch { return fallback; }
}
export function getPaperworkConfig(): Config {
    const raw = readJson<Partial<Config>>(configPath(), {});
    return { ...defaults, ...raw };
}
export function setPaperworkConfig(input: Partial<Config>): Config {
    const old = getPaperworkConfig();
    const next: Config = {
        enabled: typeof input.enabled === "boolean" ? input.enabled : old.enabled,
        endpoint: typeof input.endpoint === "string" ? input.endpoint.trim() : old.endpoint,
        driverToken: typeof input.driverToken === "string" ? input.driverToken.trim() : old.driverToken,
        driverName: typeof input.driverName === "string" ? input.driverName.trim() : old.driverName
    };
    if (next.endpoint && (!next.endpoint.startsWith("https://") || new URL(next.endpoint).username || new URL(next.endpoint).password))
        throw new Error("An HTTPS endpoint without URL credentials is required.");
    writeFileSync(configPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
    return next;
}
export function paperworkStatus() {
    const c = getPaperworkConfig();
    return {
        enabled: c.enabled,
        configured: Boolean(c.endpoint && c.driverToken),
        msdcDetected: existsSync(historyPath()),
        sentCount: readJson<State>(statePath(), { sent: [] }).sent.length
    };
}
function request(endpoint: string, token: string, event: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
        const body = Buffer.from(JSON.stringify(event), "utf8");
        const url = new URL(endpoint);
        const req = https.request(url, {
            method: "POST",
            timeout: 12000,
            headers: {
                "Content-Type": "application/json",
                "Content-Length": body.length,
                "Authorization": "Bearer " + token
            }
        }, res => {
            res.resume();
            res.on("end", () => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve();
                else reject(new Error("Paperwork endpoint HTTP " + res.statusCode));
            });
        });
        req.on("timeout", () => req.destroy(new Error("Paperwork request timeout")));
        req.on("error", reject);
        req.end(body);
    });
}
export async function scanPaperworkHistory(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
        const config = getPaperworkConfig();
        if (!config.enabled || !config.endpoint || !config.driverToken || !existsSync(historyPath())) return;
        const history = readJson<Job[]>(historyPath(), []);
        if (!Array.isArray(history)) return;
        const state = readJson<State>(statePath(), { sent: [] });
        const sent = new Set(Array.isArray(state.sent) ? state.sent : []);
        // All retained records are scanned, including separate completions of reused Trucky IDs.
        for (const dispatch of history) {
            if (!Array.isArray(dispatch.BolRecords)) continue;
            for (const bol of dispatch.BolRecords) {
                if (!bol.Completed || !bol.CompletedAtUtc) continue;
                const identity = [dispatch.JobsListId, bol.LegUniqueId, bol.LegNumber, bol.StartedAtUtc, bol.CompletedAtUtc].join("|");
                const eventId = createHash("sha256").update(identity).digest("hex");
                if (sent.has(eventId)) continue;
                const event = {
                    schemaVersion: 1, eventId, driverName: config.driverName,
                    dispatchId: dispatch.JobsListId,
                    jobId: bol.LegUniqueId,
                    origin: { city: bol.SourceCity, company: bol.SourceCompany },
                    destination: { city: bol.DestinationCity, company: bol.DestinationCompany },
                    cargo: bol.Cargo, cargoWeight: bol.CargoWeight, truck: bol.Truck,
                    plannedDistance: bol.PlannedDistance, actualDistanceMiles: bol.ActualDistanceMiles,
                    fuelUsedRaw: bol.FuelUsedGallons, // Preserve MSDC's source units; no conversion inferred.
                    cargoDamagePercent: bol.CargoDamagePercent,
                    drivingSeconds: bol.ActualDrivingSeconds,
                    startedAtUtc: bol.StartedAtUtc, completedAtUtc: bol.CompletedAtUtc,
                    completionMethod: bol.CompletionMethod
                };
                await request(config.endpoint, config.driverToken, event);
                sent.add(eventId);
                writeFileSync(statePath(), JSON.stringify({ sent: [...sent] }, null, 2));
            }
        }
    } catch (error) {
        console.warn("[Paperwork] Delivery upload pending retry:", error);
    } finally {
        busy = false;
    }
}
export function startPaperworkMonitor() {
    if (timer) return;
    timer = setInterval(() => void scanPaperworkHistory(), 15000);
    void scanPaperworkHistory();
}
export function stopPaperworkMonitor() {
    if (timer) clearInterval(timer);
    timer = undefined;
}
