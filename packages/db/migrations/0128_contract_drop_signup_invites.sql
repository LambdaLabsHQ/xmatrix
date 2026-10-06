-- Sign-up is open (#3381): no Hub release since xmatrix-v0.16.655 reads or
-- writes invite codes or claims. Apply once every serving Hub runs that
-- release or later.

SET LOCAL lock_timeout = '5s';

DROP TABLE control.signup_invite_claims;
DROP TABLE control.signup_invite_codes;
