/** Analytics Engine sink with explicit deployment metadata and a scenario's gate overrides. */
export function observabilitySink(defaults, overrides = {}) {
  const written = [];
  return {
    written,
    env: {
      RELAY_AUTHORITY_OBSERVABILITY_AE: { writeDataPoint: (point) => written.push(point) },
      RELAY_AUTHORITY_OBSERVABILITY_ENABLED: "true",
      ...defaults,
      ...overrides,
    },
  };
}
