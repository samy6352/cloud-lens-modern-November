// Loaded after first paint by <LazyMotion> in main.tsx, so the animation engine is not in the
// initial bundle. domMax (not domAnimation) because the nav highlight uses layout animations.
import { domMax } from "motion/react";

export default domMax;
