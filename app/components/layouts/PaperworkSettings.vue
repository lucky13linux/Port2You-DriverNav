<script setup lang="ts">
const api = () => (window as any).electronAPI;
const form = reactive({ enabled: false, endpoint: "", driverName: "", driverToken: "" });
const status = ref<any>(null);
const hasToken = ref(false);
const message = ref("");
const busy = ref(false);
onMounted(async () => {
    try {
        const config = await api().getPaperworkConfig();
        form.enabled = config.enabled;
        form.endpoint = config.endpoint || "";
        form.driverName = config.driverName || "";
        hasToken.value = !!config.hasToken;
        status.value = await api().getPaperworkStatus();
    } catch { message.value = "Paperwork service unavailable."; }
});
async function save() {
    busy.value = true;
    message.value = "";
    try {
        const update: any = { enabled: form.enabled, endpoint: form.endpoint, driverName: form.driverName };
        if (form.driverToken) update.driverToken = form.driverToken;
        const result = await api().updatePaperworkConfig(update);
        form.driverToken = "";
        hasToken.value = !!result.hasToken;
        status.value = await api().getPaperworkStatus();
        message.value = "Settings saved. Completed deliveries will be uploaded when enabled.";
    } catch (e: any) { message.value = String(e?.message || e); }
    finally { busy.value = false; }
}
</script>

<template>
    <section class="paperwork-panel">
        <h3>Port2You delivery paperwork</h3>
        <p>Automatically send MSDC completed deliveries to Port2You's secure dispatch server. Disabled until configured.</p>
        <p v-if="status">MSDC history: <strong>{{ status.msdcDetected ? "Detected" : "Not found" }}</strong> · Submitted locally: {{ status.sentCount }}</p>
        <label>Oracle HTTPS paperwork endpoint
            <input v-model="form.endpoint" type="url" placeholder="https://your-host/api/paperwork" />
        </label>
        <label>Driver name <input v-model="form.driverName" placeholder="Lucky" /></label>
        <label>Private driver token <input v-model="form.driverToken" type="password" :placeholder="hasToken ? 'Saved — leave blank to keep' : 'Enter token issued by management'" autocomplete="off" /></label>
        <label class="toggle"><input v-model="form.enabled" type="checkbox" /> Enable automatic paperwork uploads</label>
        <button :disabled="busy" @click="save">{{ busy ? "Saving…" : "Save paperwork settings" }}</button>
        <p v-if="message" role="status">{{ message }}</p>
        <small>Existing MSDC history is included on first enable. Use a test Discord channel initially.</small>
    </section>
</template>

<style scoped>
.paperwork-panel { margin: 18px 0; padding: 16px; border: 1px solid #435065; border-radius: 10px; color: #e6edf8; background: #142132; }
.paperwork-panel h3 { font-size: 18px; font-weight: 700; margin-bottom: 8px; }
.paperwork-panel p { font-size: 13px; margin: 8px 0; }
.paperwork-panel label { display: block; font-size: 13px; margin: 10px 0; }
.paperwork-panel input:not([type="checkbox"]) { box-sizing: border-box; display: block; width: 100%; margin-top: 4px; padding: 8px; border: 1px solid #52637a; border-radius: 5px; background: #0c1522; color: white; }
.paperwork-panel .toggle { display: flex; align-items: center; gap: 8px; }
.paperwork-panel button { padding: 8px 14px; background: #196a8b; border-radius: 5px; color: white; cursor: pointer; }
.paperwork-panel small { display: block; margin-top: 8px; color: #b9c7d8; }
</style>
