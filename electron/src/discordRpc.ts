export interface DiscordRpcPayload {
    game: string;
    connected: boolean;
    hasActiveJob: boolean;
    sourceCity?: string;
    destinationCity?: string;
    cargoName?: string;
    truckBrand?: string;
    truckName?: string;
}

// Port2You Discord application used for Rich Presence.
const DISCORD_CLIENT_ID = "1556721952469557319";
const RPC_SHUTDOWN_WAIT_MS = 1_500;

let rpcLib: any = null;
let rpcClient: any = null;
let rpcReady = false;
let lastPayloadKey = "";
let latestPayload: DiscordRpcPayload | null = null;
let sessionStartedAt = 0;
let rpcSuspended = false;
let rpcFeatureEnabled = true;

function resetDiscordRpcState() {
    lastPayloadKey = "";
    latestPayload = null;
    sessionStartedAt = 0;
}

function getRpcLibrary() {
    if (rpcLib) return rpcLib;

    try {
        // Optional dependency. If missing, TruckNav still works normally.
        // Install in electron/ with: npm install discord-rpc
        // Add your Discord application ID to DISCORD_CLIENT_ID above.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        rpcLib = require("discord-rpc");
        return rpcLib;
    } catch {
        return null;
    }
}

export async function initDiscordRpc() {
    if (!rpcFeatureEnabled) return;
    if (!DISCORD_CLIENT_ID) {
        return;
    }

    const DiscordRPC = getRpcLibrary();
    if (!DiscordRPC || rpcClient) return;

    try {
        rpcClient = new DiscordRPC.Client({ transport: "ipc" });

        rpcClient.on("ready", async () => {
            rpcReady = true;
            await setIdlePresence();
        });

        rpcClient.on("disconnected", () => {
            rpcReady = false;
        });

        await rpcClient.login({ clientId: DISCORD_CLIENT_ID });
    } catch {
        rpcClient = null;
        rpcReady = false;
    }
}

export async function updateDiscordRpc(payload: DiscordRpcPayload) {
    if (!rpcFeatureEnabled) return;
    if (!rpcClient || !rpcReady) return;

    if (payload.connected && sessionStartedAt === 0) {
        sessionStartedAt = Date.now();
    } else if (!payload.connected) {
        sessionStartedAt = 0;
    }

    latestPayload = payload;
    if (rpcSuspended) return;
    await pushCurrentPresence();
}

export async function clearDiscordRpc() {
    if (!rpcClient || !rpcReady) return;

    try {
        resetDiscordRpcState();

        if (!rpcFeatureEnabled) {
            await rpcClient.clearActivity();
            return;
        }

        await setIdlePresence();
    } catch {}
}

export async function suspendDiscordRpc() {
    rpcSuspended = true;
    await clearDiscordRpc();
}

export async function resumeDiscordRpc() {
    if (!rpcFeatureEnabled) return;
    rpcSuspended = false;
    if (!rpcClient || !rpcReady) return;
    if (latestPayload) {
        await pushCurrentPresence();
    } else {
        await setIdlePresence();
    }
}

export async function destroyDiscordRpc(useIdleFlush = true) {
    if (!rpcClient) return;

    try {
        if (rpcReady) {
            resetDiscordRpcState();

            if (useIdleFlush) {
                // Helper: Discord may cache the previous presence state and keep its timer alive.
                // We first send a clean timer free presence, then clear it, then wait a short time.
                await setIdlePresence();
                await waitForDiscordRpcFlush(250);
            }

            await rpcClient.clearActivity();
            await waitForDiscordRpcShutdown();
        }
    } catch {}

    try {
        rpcClient.destroy();
    } catch {}

    rpcClient = null;
    rpcReady = false;
    resetDiscordRpcState();
    rpcSuspended = false;
}

export async function setDiscordRpcEnabled(enabled: boolean) {
    rpcFeatureEnabled = enabled;

    if (!enabled) {
        rpcSuspended = true;
        resetDiscordRpcState();
        await destroyDiscordRpc(false);
        return;
    }

    rpcSuspended = false;
    await initDiscordRpc();
    if (latestPayload) {
        await pushCurrentPresence();
    }
}

async function waitForDiscordRpcShutdown() {
    // Helper: when TruckNav closes, Discord may keep showing the RPC for non reason.
    // This small delay gives Discord enough time to clear the presence properly.
    await new Promise((resolve) => {
        setTimeout(resolve, RPC_SHUTDOWN_WAIT_MS);
    });
}

async function waitForDiscordRpcFlush(delayMs: number) {
    // Helper: send one timer free state first so Discord can flush the old session timestamp.
    await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
    });
}

async function setIdlePresence() {
    if (!rpcClient || !rpcReady) return;

    await rpcClient.setActivity({
        details: "Driving for Port2You",
        state: "Waiting for telemetry",
        largeImageText: "Port2You",
        instance: false,
    });

    lastPayloadKey = JSON.stringify({
        details: "Driving for Port2You",
        state: "Waiting for telemetry",
    });
}

async function pushCurrentPresence() {
    if (!rpcClient || !rpcReady || !latestPayload) return;

    const normalized = buildPresence(latestPayload);
    const payloadKey = JSON.stringify(normalized);

    if (payloadKey === lastPayloadKey) {
        return;
    }

    try {
        await rpcClient.setActivity(normalized);
        lastPayloadKey = payloadKey;
    } catch {}
}

function buildPresence(payload: DiscordRpcPayload) {
    const fromCity = cleanLocation(payload.sourceCity);
    const toCity = cleanLocation(payload.destinationCity);

    let state = payload.connected ? "On the road" : "Waiting for telemetry";

    if (payload.connected && payload.hasActiveJob) {
        if (fromCity && toCity) {
            state = `${fromCity} → ${toCity}`;
        } else if (toCity) {
            state = `Delivering to ${toCity}`;
        } else if (payload.cargoName) {
            state = payload.cargoName;
        } else {
            state = "Job in progress";
        }
    }

    return {
        details: "Driving for Port2You",
        state,
        largeImageText: "Port2You",
        buttons: [
            {
                label: "Port2You DriverNav",
                url: "https://github.com/lucky13linux/Port2You-DriverNav",
            },
        ],
        startTimestamp:
            payload.connected && sessionStartedAt > 0
                ? Math.floor(sessionStartedAt / 1000)
                : undefined,
        instance: false,
    };
}

function cleanLocation(value?: string) {
    if (!value) return "";

    const trimmed = value.trim();
    if (!trimmed || trimmed === "0") return "";
    return trimmed;
}
