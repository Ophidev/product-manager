import { useLoaderData, useNavigate, useFetcher, useSearchParams } from "react-router";
import { useEffect, useCallback, useState } from "react";
import { authenticate } from "../shopify.server";
import { useLanguage } from "../context/LanguageContext";
//allows to sort the customer by name and created at
const SORT_KEYS = {
    name: "NAME",
    created: "CREATED_AT",
};
//allows to 
const CUSTOMER_FIELDS = `
    id
    displayName
    defaultEmailAddress { emailAddress marketingState }
    defaultPhoneNumber { phoneNumber }
    numberOfOrders
    amountSpent { amount currencyCode }
    defaultAddress { city provinceCode countryCodeV2 }
`;
//allows to export the headers when csv is downloaded 
const EXPORT_HEADERS = [
    "Full Name",
    "Customer ID",
    "Address",
    "Email",
    "Phone Number",
    "Company",
    "Marketing Consent",
    "Orders",
    "Tax Exempt",
];
//allow to 
function csvEscape(value) {
    const text = String(value ?? "");
    if (/[",\n]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

// header row used by both the sample CSV and the parser below 
const IMPORT_HEADERS = ["Full Name", "Email", "Phone Number", "Address", "Company"];
//default sample csv for the example based
const SAMPLE_CSV = [
    IMPORT_HEADERS.join(","),
    ["Jane Doe", "jane.doe@example.com", "+15551234567", "123 Main St, Springfield", "Acme Inc"].map(csvEscape).join(","),
].join("\n");

// splits a single CSV line into fields, respecting quoted commas
function parseCsvLine(line) {
    const fields = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
        const char = line[i];
        if (inQuotes) {
            if (char === '"' && line[i + 1] === '"') {
                current += '"';
                i += 1;
            } else if (char === '"') {
                inQuotes = false;
            } else {
                current += char;
            }
        } else if (char === '"') {
            inQuotes = true;
        } else if (char === ",") {
            fields.push(current);
            current = "";
        } else {
            current += char;
        }
    }
    fields.push(current);
    return fields;
}

// parses the uploaded CSV text into customer rows ready for the import action indexof
function parseCustomersCsv(text) {
    const lines = text.split(/\r\n|\n/).filter((line) => line.trim() !== "");
    if (lines.length < 2) return [];
//indexof
    const headers = parseCsvLine(lines[0]).map((header) => header.trim().toLowerCase());
    const nameIndex = headers.indexOf("full name");
    const emailIndex = headers.indexOf("email");
    const phoneIndex = headers.indexOf("phone number");
    const addressIndex = headers.indexOf("address");
    const companyIndex = headers.indexOf("company");

    return lines.slice(1).map((line) => {
        const fields = parseCsvLine(line);
        const fullName = (fields[nameIndex] || "").trim();
        const [firstName, ...rest] = fullName.split(" ").filter(Boolean);
        return {
            firstName: firstName || "",
            lastName: rest.join(" "),
            email: (fields[emailIndex] || "").trim(),
            phone: (fields[phoneIndex] || "").trim(),
            address: (fields[addressIndex] || "").trim(),
            company: (fields[companyIndex] || "").trim(),
        };
    });
}
//allows to .join the array with the comma
//if there is no address return null, undefined so that the it dont catch it as a error
//.join is used to join the address with, where as .filter allows to to skip the null undefined data and continue with it. 
function buildCustomersCsv(customers) {
    const lines = [EXPORT_HEADERS.join(",")];
    for (const customer of customers) {
        const address = customer.defaultAddress;
        const addressLine = address
            ? [address.address1, address.address2, address.city, address.provinceCode, address.countryCodeV2, address.zip]
            //skips the null data in the form.data
                .filter(Boolean)
                //provide the spaces
                .join(", ")
            : "";
//making the CSV file for the customer. push return name || "empty string"
        lines.push([
            customer.displayName || "",
            customer.id.split("/").pop(),
            addressLine,
            customer.defaultEmailAddress?.emailAddress || "",
            customer.defaultPhoneNumber?.phoneNumber || "",
            address?.company || "",
            customer.defaultEmailAddress?.marketingState === "SUBSCRIBED" ? "Subscribed" : "Not subscribed",
            customer.numberOfOrders ?? 0,
            customer.taxExempt ? "Yes" : "No",
        ].map(csvEscape).join(","));
    }
    return lines.join("\n");
}

// loader gets the customers list from the store
export const loader = async ({ request }) => {
    console.log("Loader Calls: customer page");
    const { admin } = await authenticate.admin(request);

    const url = new URL(request.url);
    const search = url.searchParams.get("search");
    const sort = url.searchParams.get("sort") ?? "name";
    const order = url.searchParams.get("order") ?? "asc";

    const query = search ? search : null;
    const sortKey = SORT_KEYS[sort] ?? "NAME";
    const reverse = order === "desc";
//error handling 
    try {
        const response = await admin.graphql(`
            #graphql
            query GetCustomers($first: Int!, $query: String, $sortKey: CustomerSortKeys, $reverse: Boolean) {
                customers(first: $first, query: $query, sortKey: $sortKey, reverse: $reverse) {
                    nodes { ${CUSTOMER_FIELDS} }
                }
            }
        `, { variables: { first: 50, query, sortKey, reverse } });

        const data = await response.json();
        if (data.errors?.length) {
            return { customers: null, error: data.errors[0].message, search: search ?? "", sort, order };
        }

        return { customers: data.data.customers, error: null, search: search ?? "", sort, order };
    } catch (error) {
        return { customers: null, error: error.message || "Failed to load customers.", search: search ?? "", sort, order };
    }
};

// action handles CSV export for the selected customer ids
export const action = async ({ request }) => {
    console.log("action: ")
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = formData.get("intent");
//allows to export teh csv file where as the IDs comes in the string format from the UI now it will allow to transfer it to the array 
    if (intent === "export") {
        const ids = JSON.parse(formData.get("ids") || "[]");
//selected export 
        const customers = await Promise.all(
            ids.map(async (id) => {
                const response = await admin.graphql(`
                    #graphql
                    query GetCustomerForExport($id: ID!) {
                        customer(id: $id) {
                            id
                            displayName
                            taxExempt
                            numberOfOrders
                            defaultEmailAddress { emailAddress marketingState }
                            defaultPhoneNumber { phoneNumber }
                            defaultAddress { address1 address2 city provinceCode countryCodeV2 zip company }
                        }
                    }
                `, { variables: { id } });
                return (await response.json()).data.customer;
            }),
        );

        return { intent: "export", csv: buildCustomersCsv(customers.filter(Boolean)) };
    }
// creates one customer per parsed CSV row and reports any per-row errors
//create customer through import csv file  
    if (intent === "import") {
        //get the form data rows or "undefined nothing" so that it will not throw error 
        //error handling 
        const rows = JSON.parse(formData.get("rows") || "[]");   //got the data from the frontend and parsing it to the array/object.
        let imported = 0;
        const rowErrors = [];

        for (const row of rows) {
            if (!row.email || !row.firstName) {
                rowErrors.push({ row: row.email || row.firstName || "(blank row)", message: "First name and email are required" });
                continue;
            }

            const input = { firstName: row.firstName, email: row.email };
            if (row.lastName) input.lastName = row.lastName;
            if (row.phone) input.phone = row.phone;
//api called for the create customer
            const response = await admin.graphql(`
                #graphql
                mutation CreateCustomer($input: CustomerInput!) {
                    customerCreate(input: $input) {
                        customer { id }
                        userErrors { field message }
                    }
                }
            `, { variables: { input } });

            const result = (await response.json()).data.customerCreate;
            if (result.userErrors?.length) {
                rowErrors.push({ row: row.email, message: result.userErrors[0].message });
                continue;
            }
//address create api mutation 
//toast message for the {} 
            if (row.address) {
                await admin.graphql(`
                    #graphql
                    mutation CreateCustomerAddress($customerId: ID!, $address: MailingAddressInput!, $setAsDefault: Boolean) {
                        customerAddressCreate(customerId: $customerId, address: $address, setAsDefault: $setAsDefault) {
                            userErrors { field message }
                        }
                    }
                `, { variables: { customerId: result.customer.id, address: { address1: row.address, company: row.company || undefined }, setAsDefault: true } });
            }

            imported += 1;
        }

        return { intent: "import", imported, rowErrors };
    }
//allows to delete the
    if (intent === "delete") {
        const id = formData.get("id");
        const response = await admin.graphql(`
            #graphql
            mutation DeleteCustomer($input: CustomerDeleteInput!) {
                customerDelete(input: $input) {
                    deletedCustomerId
                    userErrors { field message }
                }
            }
        `, { variables: { input: { id } } });

        const result = (await response.json()).data.customerDelete;
        return { intent: "delete", ...result };
    }

    return null;
};
//UI 
export default function Customers() {
    const { customers, error, search: initialSearch, sort, order } = useLoaderData();
    const { t: { common: c, customers: t } } = useLanguage();
    const [searchInput, setSearchInput] = useState(initialSearch);
    const [selectedIds, setSelectedIds] = useState(() => new Set());

    const navigate = useNavigate();
    const [searchParams] = useSearchParams();

    const exportFetcher = useFetcher();
    const exportResult = exportFetcher.data;
    const isExporting = exportFetcher.state !== "idle";

    const deleteFetcher = useFetcher();
    const deleteResult = deleteFetcher.data;
    const isDeleting = deleteFetcher.state !== "idle";
    const [pendingDeleteId, setPendingDeleteId] = useState(null);

    const importFetcher = useFetcher();
    const importResult = importFetcher.data;
    const isImporting = importFetcher.state !== "idle";
    const [importFile, setImportFile] = useState(null);
    const [importRows, setImportRows] = useState(null);

    const updateParam = useCallback((key, value) => {
        const params = new URLSearchParams(searchParams);
        if (value) {
            params.set(key, value);
        } else {
            params.delete(key);
        }
        navigate(`/app/customers?${params.toString()}`, { replace: true });
    }, [navigate, searchParams]);

    useEffect(() => {
        if (searchInput === initialSearch) return;
        const handle = setTimeout(() => updateParam("search", searchInput), 200);
        return () => clearTimeout(handle);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchInput]);

    useEffect(() => {
        if (exportFetcher.state === "idle" && exportResult?.intent === "export" && exportResult.csv) {
            const blob = new Blob([exportResult.csv], { type: "text/csv;charset=utf-8;" }); //allows to create  csv file 
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = "customers.csv";
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            shopify.toast.show(t.customersExportedToast);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [exportFetcher.state, exportResult]);

    useEffect(() => {
        if (deleteFetcher.state === "idle" && deleteResult?.intent === "delete") {
            if (deleteResult.userErrors?.length) {
                shopify.toast.show(deleteResult.userErrors[0].message, { isError: true });
            } else {
                shopify.toast.show(t.customerDeletedToast);
                document.getElementById("delete-customer-modal")?.hideOverlay?.();
                setPendingDeleteId(null);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deleteFetcher.state, deleteResult]);
//call the import modal
    useEffect(() => {
        if (importFetcher.state === "idle" && importResult?.intent === "import") {
            if (importResult.rowErrors?.length) {
                shopify.toast.show(`${importResult.imported} imported, ${importResult.rowErrors.length} failed`, { isError: true });
            } else {
                shopify.toast.show(`${importResult.imported} customer(s) imported`);
                document.getElementById("import-customers-modal")?.hideOverlay?.();
                setImportFile(null);
                setImportRows(null);
                navigate(".", { replace: true });
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [importFetcher.state, importResult]);

    const handleFileSelected = (event) => {
        const file = event.currentTarget.files?.[0];
        if (!file) return;
        setImportFile(file);
        const reader = new FileReader(); //file reader allows to read the imported file
        reader.onload = () => setImportRows(parseCustomersCsv(String(reader.result || "")));
        reader.readAsText(file);
    };

    const handleImport = () => {
        if (!importRows?.length) return;
        importFetcher.submit({ intent: "import", rows: JSON.stringify(importRows) }, { method: "post" });
    };
//handle downloadSample 
    const handleDownloadSample = () => {
        const blob = new Blob([SAMPLE_CSV], { type: "text/csv;charset=utf-8;" }); //alows to download csv file in the local device 
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "sample-customers.csv";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    const confirmDelete = (id) => {
        setPendingDeleteId(id);
        document.getElementById("delete-customer-modal")?.showOverlay?.();
    };

    const handleDelete = () => {
        deleteFetcher.submit({ intent: "delete", id: pendingDeleteId }, { method: "post" });
    };

    const customerList = customers?.nodes ?? [];
    const allSelected = customerList.length > 0 && selectedIds.size === customerList.length;

    const toggleAll = () => {
        if (allSelected) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(customerList.map((customer) => customer.id)));
        }
    };

    const toggleRow = (id) => {
        setSelectedIds((current) => {
            const next = new Set(current);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    const handleExport = () => {
        if (selectedIds.size === 0) {
            shopify.toast.show(t.selectOneToExport, { isError: true });
            return;
        }
        exportFetcher.submit(
            { intent: "export", ids: JSON.stringify(Array.from(selectedIds)) },
            { method: "post" },
        );
    };

    return (
        <s-page heading={t.heading}>
            <s-button slot="primary-action" href="/app/customers/new">
                {t.addCustomer}
            </s-button>
            <s-button slot="secondary-actions" onClick={handleExport} loading={isExporting}>
                {t.export}
            </s-button>
            <s-button slot="secondary-actions" commandFor="import-customers-modal" command="--show">
                {t.import}
            </s-button>

            {error && (
                <s-banner tone="critical">
                    {error}
                </s-banner>
            )}

            <s-modal id="delete-customer-modal" heading={t.deleteCustomerHeading}>
                <s-stack direction="block" gap="base">
                    <s-text>{t.confirmDeleteCustomer}</s-text>
                </s-stack>
                <s-button
                    slot="primary-action"
                    variant="primary"
                    tone="critical"
                    onClick={handleDelete}
                    loading={isDeleting}
                >
                    {c.delete}
                </s-button>
                <s-button slot="secondary-actions" commandFor="delete-customer-modal" command="--hide" variant="tertiary">
                    {c.cancel}
                </s-button>
            </s-modal>

            <s-modal id="import-customers-modal" heading={t.importCsvHeading}>
                <s-stack direction="block" gap="base">
                    <s-drop-zone
                        label={t.addFiles}
                        labelAccessibilityVisibility="exclusive"
                        accessibilityLabel={t.addFiles}
                        accept=".csv"
                        onChange={handleFileSelected}
                    >
                        {importFile && (
                            <s-text color="subdued">{importFile.name}</s-text>
                        )}
                    </s-drop-zone>
                    <s-link onClick={handleDownloadSample}>
                        {t.downloadSample}
                    </s-link>
                </s-stack>
                <s-button
                    slot="primary-action"
                    variant="primary"
                    onClick={handleImport}
                    loading={isImporting}
                    disabled={!importRows?.length}
                >
                    {t.importCustomers}
                </s-button>
                <s-button slot="secondary-actions" commandFor="import-customers-modal" command="--hide" variant="tertiary">
                    {c.cancel}
                </s-button>
            </s-modal>

            <s-section padding="none" accessibilityLabel="Customers table section">
                <s-table>
                    <s-grid slot="filters" gap="small-200" gridTemplateColumns="1fr auto">
                        <s-text-field
                            label={t.searchCustomers}
                            labelAccessibilityVisibility="exclusive"
                            icon="search"
                            placeholder={t.searchCustomers}
                            value={searchInput}
                            onInput={(event) => setSearchInput(event.currentTarget.value)}
                        />
                        <s-button
                            icon="sort"
                            variant="secondary"
                            accessibilityLabel={c.sort}
                            interestFor="sort-tooltip"
                            commandFor="sort-actions"
                        />
                        <s-tooltip id="sort-tooltip">
                            <s-text>{c.sort}</s-text>
                        </s-tooltip>
                        <s-popover id="sort-actions">
                            <s-stack gap="none">
                                <s-box padding="small">
                                    <s-choice-list
                                        label={c.sortBy}
                                        onChange={(event) => updateParam("sort", event.currentTarget.values[0])}
                                    >
                                        <s-choice value="name" selected={sort === "name"}>{t.customerName}</s-choice>
                                        <s-choice value="created" selected={sort === "created"}>{c.created}</s-choice>
                                    </s-choice-list>
                                </s-box>
                                <s-divider />
                                <s-box padding="small">
                                    <s-choice-list
                                        label={c.orderBy}
                                        onChange={(event) => updateParam("order", event.currentTarget.values[0])}
                                    >
                                        <s-choice value="asc" selected={order === "asc"}>{c.aToZ}</s-choice>
                                        <s-choice value="desc" selected={order === "desc"}>{c.zToA}</s-choice>
                                    </s-choice-list>
                                </s-box>
                            </s-stack>
                        </s-popover>
                    </s-grid>
                    <s-table-header-row>
                        <s-table-header>
                            <s-checkbox
                                accessibilityLabel={t.selectAllCustomers}
                                checked={allSelected}
                                onChange={toggleAll}
                            />
                        </s-table-header>
                        <s-table-header listSlot="primary">{t.customerName}</s-table-header>
                        <s-table-header>{t.emailSubscription}</s-table-header>
                        <s-table-header>{t.location}</s-table-header>
                        <s-table-header format="numeric">{t.orders}</s-table-header>
                        <s-table-header format="numeric">{t.amountSpent}</s-table-header>
                        <s-table-header>{t.actions}</s-table-header>
                    </s-table-header-row>

                    <s-table-body>
                        {!error && customerList.length === 0 && (
                            <s-table-row>
                                <s-table-cell>
                                    <s-box padding="large">
                                        <s-stack direction="block" gap="base" alignItems="center">
                                            <s-heading>{t.noCustomersFound}</s-heading>
                                            <s-paragraph color="subdued">
                                                {initialSearch
                                                    ? t.tryDifferentSearch
                                                    : t.addCustomerToStart}
                                            </s-paragraph>
                                            {!initialSearch && (
                                                <s-button href="/app/customers/new" variant="primary">
                                                    {t.addCustomer}
                                                </s-button>
                                            )}
                                        </s-stack>
                                    </s-box>
                                </s-table-cell>
                                <s-table-cell></s-table-cell>
                                <s-table-cell></s-table-cell>
                                <s-table-cell></s-table-cell>
                                <s-table-cell></s-table-cell>
                                <s-table-cell></s-table-cell>
                                <s-table-cell></s-table-cell>
                            </s-table-row>
                        )}

                        {customerList.map((customer) => {
                            const numericId = customer.id.split("/").pop();
                            const subscribed = customer.defaultEmailAddress?.marketingState === "SUBSCRIBED";
                            const address = customer.defaultAddress;
                            const location = address
                                ? [address.city, address.provinceCode || address.countryCodeV2].filter(Boolean).join(", ")
                                : "—";
                            const menuId = `customer-menu-${numericId}`;

                            return (
                                <s-table-row key={customer.id}>
                                    <s-table-cell>
                                        <s-checkbox
                                            accessibilityLabel={`Select ${customer.displayName}`}
                                            checked={selectedIds.has(customer.id)}
                                            onChange={() => toggleRow(customer.id)}
                                        />
                                    </s-table-cell>
                                    <s-table-cell>
                                        <s-text>{customer.displayName}</s-text>
                                    </s-table-cell>
                                    <s-table-cell>
                                        <s-badge tone={subscribed ? "success" : "neutral"}>
                                            {subscribed ? t.subscribed : t.notSubscribed}
                                        </s-badge>
                                    </s-table-cell>
                                    <s-table-cell>{location}</s-table-cell>
                                    <s-table-cell>{customer.numberOfOrders ?? 0}</s-table-cell>
                                    <s-table-cell>
                                        {customer.amountSpent
                                            ? `${customer.amountSpent.amount} ${customer.amountSpent.currencyCode}`
                                            : "—"}
                                    </s-table-cell>
                                    <s-table-cell>
                                        <s-button
                                            icon="edit"
                                            variant="tertiary"
                                            href={`/app/customers/${numericId}`}
                                            accessibilityLabel={`Edit ${customer.displayName}`}
                                            interestFor={`edit-tooltip-${numericId}`}
                                        />
                                        <s-tooltip id={`edit-tooltip-${numericId}`}>
                                            <s-text>{t.updateCustomer}</s-text>
                                        </s-tooltip>
                                        <s-button
                                            icon="menu-horizontal"
                                            variant="tertiary"
                                            accessibilityLabel="More actions"
                                            commandFor={menuId}
                                        />
                                        <s-menu id={menuId} accessibilityLabel="Customer actions">
                                            <s-button
                                                variant="tertiary"
                                                tone="critical"
                                                icon="delete"
                                                onClick={() => confirmDelete(customer.id)}
                                            >
                                                {t.deleteCustomerAction}
                                            </s-button>
                                        </s-menu>
                                    </s-table-cell>
                                </s-table-row>
                            );
                        })}
                    </s-table-body>
                </s-table>
            </s-section>
        </s-page>
    );
}
