// lib0/webcrypto for React Native (see metro.config.js): Yjs needs only random numbers.
import { getRandomValues as random } from "expo-crypto";

export const getRandomValues = random;
export const subtle = undefined;
