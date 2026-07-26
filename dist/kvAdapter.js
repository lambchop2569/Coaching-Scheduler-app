const KV_ENABLED = Boolean(process.env.VERCEL_KV_NAMESPACE);
let kvClient = null;
async function initKv() {
    if (!KV_ENABLED)
        return false;
    if (kvClient)
        return true;
    try {
        const mod = await import('@vercel/kv');
        // Module may export default or named functions depending on version.
        kvClient = (mod && (mod.default ?? mod));
        return true;
    }
    catch (err) {
        console.error('Failed to initialize Vercel KV client', err);
        return false;
    }
}
export async function kvGetSchedulerData() {
    if (!(await initKv()))
        return null;
    try {
        const val = await kvClient.get('scheduler:data');
        return val ?? null;
    }
    catch (err) {
        console.error('Vercel KV get(scheduler:data) failed', err);
        return null;
    }
}
export async function kvSetSchedulerData(data) {
    if (!(await initKv()))
        return false;
    try {
        await kvClient.set('scheduler:data', data);
        return true;
    }
    catch (err) {
        console.error('Vercel KV set(scheduler:data) failed', err);
        return false;
    }
}
export async function kvGetAppointments() {
    if (!(await initKv()))
        return null;
    try {
        const val = await kvClient.get('scheduler:appointments');
        return Array.isArray(val) ? val : [];
    }
    catch (err) {
        console.error('Vercel KV get(scheduler:appointments) failed', err);
        return null;
    }
}
export async function kvSetAppointments(sessions) {
    if (!(await initKv()))
        return false;
    try {
        await kvClient.set('scheduler:appointments', sessions);
        return true;
    }
    catch (err) {
        console.error('Vercel KV set(scheduler:appointments) failed', err);
        return false;
    }
}
export const kvAvailable = KV_ENABLED;
