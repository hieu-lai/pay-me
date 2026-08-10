# PayMe

PayMe lets a user specify where another person should send requested money.

## Language

**Payment Destination**:
A saved Bank Account or PayID that identifies where a User can receive money and, for the current PayTo scope, the account from which the User may authorize a debit.
_Avoid_: Payment method, payout method, receiving method

**Bank Account**:
A Payment Destination identified by an account name, BSB, and account number.

**PayID**:
A Payment Destination identified by a mobile number, email address, ABN, or Organisation Identifier.

**Organisation Identifier**:
A PayID identifier representing a business, organisation, undertaking, campaign, product, or geographic location.
_Avoid_: Organisation name

**Default Destination**:
The single Payment Destination automatically selected for a User when they have one or more destinations.
_Avoid_: Primary destination

**Requester**:
A User who asks one or more Payers to authorize a PayTo Agreement that directs money to the Requester.
In PayTo network terminology, the Requester is the Creditor.

**Payer**:
A User whom a Requester asks to authorize a PayTo Agreement that permits money to be debited from the Payer's account.
In PayTo network terminology, the Payer is the Debtor.
_Avoid_: Recipient, when referring to the person being asked to pay

**PayTo Agreement**:
An authorization from a Payer that permits a Requester to initiate payments under agreed terms.

**Money Request**:
A Requester's request for one fixed amount from each of one to five Payers. A Money Request creates one PayTo Agreement for each Payer.
_Avoid_: Payment Request

**PayMe Username**:
An optional, PayMe-owned public identifier chosen by a User during onboarding and used by other Users to find them. A User without a PayMe Username remains discoverable by name.
_Avoid_: Clerk username
