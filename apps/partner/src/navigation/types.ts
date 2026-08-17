/**
 * src/navigation/types.ts
 * Same typed-navigation principle as the customer app.
 */

export type AuthStackParamList = {
  PhoneEntry: undefined;
  OtpVerify: { phone: string };
};

export type RootStackParamList = {
  OrderList: undefined;
  OrderDetail: { orderId: string };
};
