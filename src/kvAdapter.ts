import type { SchedulerData, BookedSession } from './index.js';

const KV_ENABLED = Boolean(process.env.VERCEL_KV_NAMESPACE);

let kvClient: any = null;

async function initKv(): Promise<boolean> {
    if (!KV_ENABLED) return false;
    if (kvClient) return true;

    try {
        const mod = await import('@vercel/kv');
        // Module may export default or named functions depending on version.
        kvClient = (mod && (mod.default ?? mod));
        return true;
    } catch (err: any) {
        console.error('Failed to initialize Vercel KV client', err);
        return false;
    }
}

export async function kvGetSchedulerData(): Promise<SchedulerData | null> {
    if (!(await initKv())) return null;
    try {
        const val = await kvClient.get('scheduler:data');
        return val ?? null;
    } catch (err: any) {
        console.error('Vercel KV get(scheduler:data) failed', err);
        return null;
    }
}

export async function kvSetSchedulerData(data: SchedulerData): Promise<boolean> {
    if (!(await initKv())) return false;
    try {
        await kvClient.set('scheduler:data', data);
        return true;
    } catch (err: any) {
        console.error('Vercel KV set(scheduler:data) failed', err);
        return false;
    }
}

export async function kvGetAppointments(): Promise<BookedSession[] | null> {
    if (!(await initKv())) return null;
    try {
        const val = await kvClient.get('scheduler:appointments');
        return Array.isArray(val) ? val : [];
    } catch (err: any) {
        console.error('Vercel KV get(scheduler:appointments) failed', err);
        return null;
    }
}

export async function kvSetAppointments(sessions: BookedSession[]): Promise<boolean> {
    if (!(await initKv())) return false;
    try {
        await kvClient.set('scheduler:appointments', sessions);
        return true;
    } catch (err: any) {
        console.error('Vercel KV set(scheduler:appointments) failed', err);
        return false;
    }
}

export const kvAvailable = KV_ENABLED;
