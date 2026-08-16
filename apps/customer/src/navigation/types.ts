/**
 * src/navigation/types.ts
 * Typed navigation params. Every screen's route.params is checked at
 * compile time — a screen cannot navigate with a missing or wrong-shaped
 * param, matching the same "the compiler catches mistakes" principle
 * applied throughout the backend (CLAUDE.md's branded-types rationale).
 */

export type AuthStackParamList = {
  PhoneEntry: undefined;
  OtpVerify: { phone: string };
};

export type RootStackParamList = {
  Home: undefined;
  LaundryBuilder: undefined;
  LaundryReview: { groups: LaundryGroupDraft[] };
  CourierBuilder: undefined;
  CourierReview: { parcels: Record<string, number>; pickupAddress: string; dropoffAddress: string };
  MockPayment: { orderId: string; amount: number; serviceLabel: string };
  OrderTracking: { orderId: string };
};

export interface LaundryGroupDraft {
  readonly categoryKey: string;
  readonly items: Record<string, number>;
  readonly treatmentKey: string;
  readonly qualityKey: string;
}
