import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import { useLanguage } from "../context/LanguageContext";
//languages default english
const LANGUAGES = [
    { code: "en", name: "English" },
    { code: "fr", name: "French" },
    { code: "de", name: "German" },
    { code: "es", name: "Spanish" },
    { code: "it", name: "Italian" },
    { code: "pt", name: "Portuguese" },
    { code: "nl", name: "Dutch" },
    { code: "ja", name: "Japanese" },
    { code: "zh-CN", name: "Chinese (Simplified)" },
    { code: "hi", name: "Hindi" },
    { code: "ar", name: "Arabic" },
];
//countries
const COUNTRIES = [
    ["US", "United States"], ["CA", "Canada"], ["GB", "United Kingdom"], ["AU", "Australia"],
    ["IN", "India"], ["DE", "Germany"], ["FR", "France"], ["IT", "Italy"], ["ES", "Spain"],
    ["NL", "Netherlands"], ["BE", "Belgium"], ["CH", "Switzerland"], ["AT", "Austria"],
    ["SE", "Sweden"], ["NO", "Norway"], ["DK", "Denmark"], ["FI", "Finland"], ["IE", "Ireland"],
    ["PT", "Portugal"], ["PL", "Poland"], ["GR", "Greece"], ["CZ", "Czechia"], ["HU", "Hungary"],
    ["RO", "Romania"], ["JP", "Japan"], ["CN", "China"], ["KR", "South Korea"], ["SG", "Singapore"],
    ["MY", "Malaysia"], ["TH", "Thailand"], ["ID", "Indonesia"], ["PH", "Philippines"], ["VN", "Vietnam"],
    ["AE", "United Arab Emirates"], ["SA", "Saudi Arabia"], ["IL", "Israel"], ["ZA", "South Africa"],
    ["NG", "Nigeria"], ["EG", "Egypt"], ["MX", "Mexico"], ["BR", "Brazil"], ["AR", "Argentina"],
    ["CL", "Chile"], ["CO", "Colombia"], ["PE", "Peru"], ["NZ", "New Zealand"], ["PK", "Pakistan"],
    ["BD", "Bangladesh"], ["LK", "Sri Lanka"], ["TR", "Turkey"], ["RU", "Russia"], ["UA", "Ukraine"],
].map(([code, name]) => ({ code, name }));
//dial-codes
const DIAL_CODES = [
    { dial: "+1", label: "+1 (US/Canada)" },
    { dial: "+44", label: "+44 (UK)" },
    { dial: "+91", label: "+91 (India)" },
    { dial: "+61", label: "+61 (Australia)" },
    { dial: "+49", label: "+49 (Germany)" },
    { dial: "+33", label: "+33 (France)" },
    { dial: "+39", label: "+39 (Italy)" },
    { dial: "+34", label: "+34 (Spain)" },
    { dial: "+31", label: "+31 (Netherlands)" },
    { dial: "+81", label: "+81 (Japan)" },
    { dial: "+86", label: "+86 (China)" },
    { dial: "+65", label: "+65 (Singapore)" },
    { dial: "+971", label: "+971 (UAE)" },
    { dial: "+27", label: "+27 (South Africa)" },
    { dial: "+55", label: "+55 (Brazil)" },
    { dial: "+52", label: "+52 (Mexico)" },
    { dial: "+64", label: "+64 (New Zealand)" },
    { dial: "+92", label: "+92 (Pakistan)" },
    { dial: "+880", label: "+880 (Bangladesh)" },
    { dial: "+94", label: "+94 (Sri Lanka)" },
];
//split the phone 
function splitPhone(phone) {
    if (!phone) return { dialCode: "+1", number: "" };
    const match = DIAL_CODES.find((entry) => phone.startsWith(entry.dial));
    if (match) {
        return { dialCode: match.dial, number: phone.slice(match.dial.length).trim() };
    }
    return { dialCode: "+1", number: phone.replace(/^\+/, "") };
}

// loader fetches location for a language default; if editing, fetches full customer + default address
export const loader = async ({ request, params }) => {
    console.log("loader : loader call for edit")
    const { admin } = await authenticate.admin(request);
    const isNew = params.id === "new";

    if (isNew) {
        return { isNew: true, customer: null };
    }
//not new then edit,customer then open the particular cx id 
    const customerId = `gid://shopify/Customer/${params.id}`;
    const response = await admin.graphql(`
        #graphql
        query GetCustomerForEdit($id: ID!) {
            customer(id: $id) {
                id
                firstName
                lastName
                locale
                phone
                defaultEmailAddress { emailAddress }
                defaultAddress {
                    id
                    address1
                    address2
                    city
                    provinceCode
                    countryCodeV2
                    zip
                    phone
                }
            }
        }
    `, { variables: { id: customerId } });
//if there is no data throw error 
    const data = (await response.json()).data;
    if (!data.customer) {
        throw new Response("Customer not found", { status: 404 });
    }

    return { isNew: false, customer: data.customer };
};

export const action = async ({ request, params }) => {
    console.log("Action: customer edit page");
    const { admin } = await authenticate.admin(request);
    const isNew = params.id === "new";
    const formData = await request.formData();
    const payload = JSON.parse(formData.get("payload") || "{}"); //converting string to JS object 
// .............................................................................................
    const { firstName, lastName, email, phone, locale, address } = payload;

    if (!firstName || !firstName.trim()) {
        return { userErrors: [{ field: ["firstName"], message: "First name is required" }] };
    }
    if (!lastName || !lastName.trim()) {
        return { userErrors: [{ field: ["lastName"], message: "Last name is required" }] };
    }
    //regex syntax   --- something@something.com
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { userErrors: [{ field: ["email"], message: "A valid email is required" }] };
    }

    async function saveAddress(customerId, existingAddressId) {
        if (!address?.address1?.trim()) return null;

        const addressInput = {
            address1: address.address1.trim(),
            address2: address.address2?.trim() || undefined,
            city: address.city?.trim() || undefined,
            provinceCode: address.state?.trim() || undefined,
            countryCode: address.country?.trim() || undefined,
            zip: address.postalCode?.trim() || undefined,
            phone: address.phone?.trim() || undefined,
        };

        if (existingAddressId) {
            const response = await admin.graphql(`
                #graphql
                mutation UpdateCustomerAddress($customerId: ID!, $addressId: ID!, $address: MailingAddressInput!, $setAsDefault: Boolean) {
                    customerAddressUpdate(customerId: $customerId, addressId: $addressId, address: $address, setAsDefault: $setAsDefault) {
                        address { id }
                        userErrors { field message }
                    }
                }
            `, { variables: { customerId, addressId: existingAddressId, address: addressInput, setAsDefault: true } });
            return (await response.json()).data.customerAddressUpdate.userErrors;
        }
//create customer address api mutaion 
        const response = await admin.graphql(`
            #graphql
            mutation CreateCustomerAddress($customerId: ID!, $address: MailingAddressInput!, $setAsDefault: Boolean) {
                customerAddressCreate(customerId: $customerId, address: $address, setAsDefault: $setAsDefault) {
                    address { id }
                    userErrors { field message }
                }
            }
        `, { variables: { customerId, address: addressInput, setAsDefault: true } });
        return (await response.json()).data.customerAddressCreate.userErrors;
    }
//create customer new ID 
    if (isNew) {
        const input = { firstName, lastName, email };
        if (locale) input.locale = locale;
        if (phone) input.phone = phone;
//create customer api 
        const response = await admin.graphql(`
            #graphql
            mutation CreateCustomer($input: CustomerInput!) {
                customerCreate(input: $input) {
                    customer { id }
                    userErrors { field message }
                }
            }
        `, { variables: { input } });

        const data = await response.json();
        const result = data.data.customerCreate;
        if (result.userErrors?.length) {
            return { userErrors: result.userErrors };
        }

        const addressErrors = await saveAddress(result.customer.id, null);
        if (addressErrors?.length) {
            return { userErrors: addressErrors };
        }

        return { success: true };
    }

    const customerId = `gid://shopify/Customer/${params.id}`;
    const { initial, addressId } = payload;
//dirty-state for the save bar------------------------------------------------------------------------------
    const customerUpdateInput = { id: customerId };
    let needsUpdate = false;
    if (firstName !== initial.firstName) { customerUpdateInput.firstName = firstName; needsUpdate = true; }
    if (lastName !== initial.lastName) { customerUpdateInput.lastName = lastName; needsUpdate = true; }
    if (email !== initial.email) { customerUpdateInput.email = email; needsUpdate = true; }
    if (phone !== initial.phone) { customerUpdateInput.phone = phone || null; needsUpdate = true; }
    if (locale !== initial.locale) { customerUpdateInput.locale = locale; needsUpdate = true; }

    if (needsUpdate) {
        const response = await admin.graphql(`
            #graphql
            mutation UpdateCustomer($customer: CustomerInput!) {
                customerUpdate(input: $customer) {
                    customer { id }
                    userErrors { field message }
                }
            }
        `, { variables: { customer: customerUpdateInput } });

        const result = (await response.json()).data.customerUpdate;
        if (result.userErrors?.length) {
            return { userErrors: result.userErrors };
        }
    }

    const addressChanged = JSON.stringify(address) !== JSON.stringify(initial.address);  //converting object to string because of form data to send the details 
    if (addressChanged) {
        const addressErrors = await saveAddress(customerId, addressId);
        if (addressErrors?.length) {
            return { userErrors: addressErrors };
        }
    }

    return { success: true };
};
//UI for the edit page
export default function CustomerForm() {
    const { isNew, customer } = useLoaderData();
    const { t: { customerForm: t } } = useLanguage();
    const navigate = useNavigate();
    const fetcher = useFetcher();   //api call without full page reload 
    const result = fetcher.data;
    const isSaving = fetcher.state !== "idle";

    const initialPhone = splitPhone(customer?.phone);

    const [firstName, setFirstName] = useState(customer?.firstName ?? "");
    const [lastName, setLastName] = useState(customer?.lastName ?? "");
    const [locale, setLocale] = useState(customer?.locale ?? "en");
    const [email, setEmail] = useState(customer?.defaultEmailAddress?.emailAddress ?? "");
    const [dialCode, setDialCode] = useState(initialPhone.dialCode);
    const [phoneNumber, setPhoneNumber] = useState(initialPhone.number);

    const defaultAddress = customer?.defaultAddress;
    const [address1, setAddress1] = useState(defaultAddress?.address1 ?? "");
    const [address2, setAddress2] = useState(defaultAddress?.address2 ?? "");
    const [city, setCity] = useState(defaultAddress?.city ?? "");
    const [state, setState] = useState(defaultAddress?.provinceCode ?? "");
    const [country, setCountry] = useState(defaultAddress?.countryCodeV2 ?? "");
    const [postalCode, setPostalCode] = useState(defaultAddress?.zip ?? "");
    const [addressPhone, setAddressPhone] = useState(defaultAddress?.phone ?? "");

    useEffect(() => {
        if (result?.success && !isSaving) {
            shopify.toast.show(isNew ? t.customerCreatedToast : t.customerUpdatedToast);
            navigate("/app/customers");
        } else if (result?.userErrors?.length && !isSaving) {
            shopify.toast.show(result.userErrors[0].message, { isError: true });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [result, isSaving]);

    const handleDiscard = () => {
        navigate("/app/customers");
    };

    const handleSubmit = (event) => {
        event.preventDefault();

        const phone = phoneNumber.trim() ? `${dialCode}${phoneNumber.trim().replace(/\D/g, "")}` : "";

        const payload = {
            firstName,
            lastName,
            email,
            phone,
            locale,
            address: {
                address1,
                address2,
                city,
                state,
                country,
                postalCode,
                phone: addressPhone,
            },
        };

        if (!isNew) {
            const initialPhoneValue = customer.phone ?? "";
            payload.initial = {
                firstName: customer.firstName ?? "",
                lastName: customer.lastName ?? "",
                email: customer.defaultEmailAddress?.emailAddress ?? "",
                phone: initialPhoneValue,
                locale: customer.locale ?? "",
                address: {
                    address1: defaultAddress?.address1 ?? "",
                    address2: defaultAddress?.address2 ?? "",
                    city: defaultAddress?.city ?? "",
                    state: defaultAddress?.provinceCode ?? "",
                    country: defaultAddress?.countryCodeV2 ?? "",
                    postalCode: defaultAddress?.zip ?? "",
                    phone: defaultAddress?.phone ?? "",
                },
            };
            payload.addressId = defaultAddress?.id ?? null;
        }

        fetcher.submit({ payload: JSON.stringify(payload) }, { method: "post" });
    };

    return (
        <s-page heading={isNew ? t.addCustomerHeading : `${customer.firstName} ${customer.lastName}`}>
            <s-link href="/app/customers" slot="breadcrumb-actions">{t.customersBreadcrumb}</s-link>

            {result?.userErrors?.length > 0 && (
                <s-banner tone="critical">
                    {result.userErrors[0].message}
                </s-banner>
            )}

            <form data-save-bar data-discard-confirmation onSubmit={handleSubmit} onReset={handleDiscard}>
                <s-stack direction="block" gap="base">
                    <s-section heading={t.customerOverview}>
                        <s-stack direction="block" gap="base">
                            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                                <s-text-field
                                    label={t.firstName}
                                    name="firstName"
                                    required
                                    value={firstName}
                                    onInput={(event) => setFirstName(event.currentTarget.value)}
                                />
                                <s-text-field
                                    label={t.lastName}
                                    name="lastName"
                                    required
                                    value={lastName}
                                    onInput={(event) => setLastName(event.currentTarget.value)}
                                />
                            </s-grid>
                            <s-select
                                label={t.language}
                                name="locale"
                                value={locale}
                                onChange={(event) => setLocale(event.currentTarget.value)}
                            >
                                {LANGUAGES.map((language) => (
                                    <s-option key={language.code} value={language.code}>{language.name}</s-option>
                                ))}
                            </s-select>
                            <s-email-field
                                label={t.email}
                                name="email"
                                required
                                value={email}
                                onInput={(event) => setEmail(event.currentTarget.value)}
                            />
                            <s-grid gridTemplateColumns="160px 1fr" gap="base">
                                <s-select
                                    label={t.countryCode}
                                    name="dialCode"
                                    value={dialCode}
                                    onChange={(event) => setDialCode(event.currentTarget.value)}
                                >
                                    {DIAL_CODES.map((entry) => (
                                        <s-option key={entry.dial} value={entry.dial}>{entry.label}</s-option>
                                    ))}
                                </s-select>
                                <s-text-field
                                    label={t.phoneNumber}
                                    name="phoneNumber"
                                    placeholder={t.phoneNumberPlaceholder}
                                    value={phoneNumber}
                                    onInput={(event) => setPhoneNumber(event.currentTarget.value)}
                                />
                            </s-grid>
                        </s-stack>
                    </s-section>

                    <s-section heading={t.defaultAddress}>
                        <s-stack direction="block" gap="base">
                            <s-text-field
                                label={t.addressLine1}
                                name="address1"
                                value={address1}
                                onInput={(event) => setAddress1(event.currentTarget.value)}
                            />
                            <s-text-field
                                label={t.addressLine2}
                                name="address2"
                                value={address2}
                                onInput={(event) => setAddress2(event.currentTarget.value)}
                            />
                            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                                <s-text-field
                                    label={t.city}
                                    name="city"
                                    value={city}
                                    onInput={(event) => setCity(event.currentTarget.value)}
                                />
                                <s-text-field
                                    label={t.stateProvince}
                                    name="state"
                                    value={state}
                                    onInput={(event) => setState(event.currentTarget.value)}
                                />
                            </s-grid>
                            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                                <s-select
                                    label={t.country}
                                    name="country"
                                    placeholder={t.selectCountry}
                                    value={country}
                                    onChange={(event) => setCountry(event.currentTarget.value)}
                                >
                                    <s-option value="">{t.selectCountry}</s-option>
                                    {COUNTRIES.map((entry) => (
                                        <s-option key={entry.code} value={entry.code}>{entry.name}</s-option>
                                    ))}
                                </s-select>
                                <s-text-field
                                    label={t.postalCode}
                                    name="postalCode"
                                    value={postalCode}
                                    onInput={(event) => setPostalCode(event.currentTarget.value)}
                                />
                            </s-grid>
                            <s-text-field
                                label={t.phone}
                                name="addressPhone"
                                value={addressPhone}
                                onInput={(event) => setAddressPhone(event.currentTarget.value)}
                            />
                        </s-stack>
                    </s-section>
                </s-stack>
            </form>
        </s-page>
    );
}
