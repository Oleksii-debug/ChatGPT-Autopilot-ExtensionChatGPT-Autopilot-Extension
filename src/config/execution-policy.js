// Release-variant policy. The standard package keeps ChatGPT's current
// reasoning effort untouched. The High package verifies High before prompt insertion.
export const EXECUTION_POLICY = Object.freeze({
  variantId: 'high',
  forceHighEffort: true,
});
