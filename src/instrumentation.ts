export async function register() {
    // Runs env validation once per cold start inside the src/ convention directory.
    await import("@/lib/env");
}
