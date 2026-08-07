# PayMe

PayMe lets a user specify where another person should send requested money.

## Language

**Payment Destination**:
A saved destination at which a User can receive money. A Payment Destination is either a Bank Account or a PayID.
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
