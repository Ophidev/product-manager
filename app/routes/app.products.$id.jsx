import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import { useLanguage } from "../context/LanguageContext";

const PRODUCT_FIELDS = `
    id
    title
    status
    totalInventory
    createdAt
    featuredImage { url altText }
    variants(first: 1) { nodes { id price } }
`;
//helps to read the data -- bring loader to read the data first 
export const loader = async ({ request, params }) => {
    console.log("🍥 loader",{
        productId: params.id,
        method: request.method,
        url: request.url,
    });
    const { admin } = await authenticate.admin(request);
    const isNew = params.id === "new";

    const locationResponse = await admin.graphql(`
        # Query the location used for inventory operations id represent from the scheme of GQL
        query PrimaryLocation {
            location { id }
        }
    `);
    const locationId = (await locationResponse.json()).data.location.id;
//if the inventory location ID is new and no ID is present for the particular
    if (isNew) {
        return { isNew: true, product: null, locationId, categories: [] };
    }
// URL which redirects profucts/$
    const productId = `gid://shopify/Product/${params.id}`;
    const response = await admin.graphql(`
        #graphql
        query GetProductForEdit($id: ID!, $locationId: ID!) {
            product(id: $id) {
                id
                title
                descriptionHtml
                status
                category {
                    id
                    name
                }
                media(first: 10) {
                    nodes {
                        id
                        alt
                        mediaContentType
                        ... on MediaImage {
                            image { url }
                        }
                    }
                }
                variants(first: 1) {
                    nodes {
                        id
                        price
                        inventoryItem {
                            id
                            inventoryLevel(locationId: $locationId) {
                                quantities(names: ["available"]) {
                                    name
                                    quantity
                                }
                            }
                        }
                    }
                }
            }
        }
    `, { variables: { id: productId, locationId } });
//error handling if the product is not found 
    const data = (await response.json()).data;
    if (!data.product) {
        throw new Response("Product not found", { status: 404 });
    }

    const categoriesResponse = await admin.graphql(`
        query TopLevelCategories {
            taxonomy {
                categories(first: 20) {
                    nodes { id name isLeaf }
                }
            }
        }
    `);
    const categories = (await categoriesResponse.json()).data.taxonomy.categories.nodes;
    return { isNew: false, product: data.product, locationId, categories };
};

async function uploadImages(admin, imageFiles, title) {
    const stagedResponse = await admin.graphql(`

        mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
            stagedUploadsCreate(input: $input) {
                stagedTargets {
                    url
                    resourceUrl
                    parameters { name value }
                }
                userErrors { field message }
            }
        }
    `, {
        variables: {
            input: imageFiles.map((file) => ({
                filename: file.name,
                mimeType: file.type,
                resource: "IMAGE",
                httpMethod: "POST",
            })),
        },
    });

    const stagedData = (await stagedResponse.json()).data.stagedUploadsCreate;
    if (stagedData.userErrors?.length) {
        return { error: stagedData.userErrors };
    }

    const media = [];
    for (let i = 0; i < stagedData.stagedTargets.length; i++) {
        const target = stagedData.stagedTargets[i];
        const file = imageFiles[i];
        const uploadForm = new FormData();
        for (const { name, value } of target.parameters) {
            uploadForm.append(name, value);
        }
        uploadForm.append("file", file, file.name);

        const uploadResponse = await fetch(target.url, { method: "POST", body: uploadForm });
        if (!uploadResponse.ok) {
            return { error: [{ field: ["images"], message: "Image upload failed." }] };
        }
        media.push({ originalSource: target.resourceUrl, alt: title });
    }

    return { media };
}
//to write/ edit action -----
export const action = async ({ request, params }) => {
    // test cases
    console.log("Action: Called",{
        productId: params.id,
        method: request.method,
        url: request.url,
    });
    const { admin } = await authenticate.admin(request);
    console.log("Action: Authentication")
    const isNew = params.id === "new";
    const formData = await request.formData();
    const payload = JSON.parse(formData.get("payload") || "{}");
    const newImageFiles = formData.getAll("images").filter((file) => file && typeof file === "object" && file.size > 0);

    const { title, description, price, inventory, status } = payload;

    if (!title || !title.trim()) {
        return { userErrors: [{ field: ["title"], message: "Title is required" }] };
    }

    const inventoryQuantity = Number(inventory);
    if (!Number.isInteger(inventoryQuantity) || inventoryQuantity < 0) {
        return { userErrors: [{ field: ["inventory"], message: "Inventory must be a whole number of 0 or more." }] };
    }

    if (isNew) {
        let stagedFiles = [];
        if (newImageFiles.length > 0) {
            const uploaded = await uploadImages(admin, newImageFiles, title);
            if (uploaded.error) return { userErrors: uploaded.error };
            stagedFiles = uploaded.media.map((file) => ({ ...file, contentType: "IMAGE" }));
        }

        const locationResponse = await admin.graphql(`
            #graphql
            query PrimaryLocation {
                location { id }
            }
        `);
        const locationId = (await locationResponse.json()).data.location.id;

        const productInput = {
            title,
            status: status || "ACTIVE",
            productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
            variants: [{
                optionValues: [{ optionName: "Title", name: "Default Title" }],
                price: price || "0.00",
                inventoryQuantities: [{ locationId, name: "available", quantity: inventoryQuantity }],
            }],
        };
        if (description) productInput.descriptionHtml = description;
        if (stagedFiles.length) productInput.files = stagedFiles;

        const response = await admin.graphql(`
            #graphql
            mutation CreateProduct($input: ProductSetInput!) {
                productSet(synchronous: true, input: $input) {
                    product { ${PRODUCT_FIELDS} }
                    userErrors { field message }
                }
            }
        `, { variables: { input: productInput } });

        const data = await response.json();
        const result = data.data.productSet;
        if (result.userErrors?.length) {
            return { userErrors: result.userErrors };
        }

        return { success: true, product: result.product };
    }

    const productId = `gid://shopify/Product/${params.id}`;
    const {
        initial,
        categoryId,
        variantId,
        inventoryItemId,
        locationId,
        removedMediaIds,
    } = payload;
//condition for the product update 
    const productUpdateInput = { id: productId };
    let needsProductUpdate = false;
    if (title !== initial.title) {
        productUpdateInput.title = title;
        needsProductUpdate = true;
    }
    if (description !== initial.description) {
        productUpdateInput.descriptionHtml = description;
        needsProductUpdate = true;
    }
    if (status !== initial.status) {
        productUpdateInput.status = status;
        needsProductUpdate = true;
    }
    if (categoryId !== initial.categoryId) {
        productUpdateInput.category = categoryId || null;
        needsProductUpdate = true;
    }
// mutation for product update where the error comes
    if (needsProductUpdate) {
        const response = await admin.graphql(`
            
            mutation UpdateProductBasics($product: ProductUpdateInput!) {
                productUpdate(product: $product) {
                    product { id }
                    userErrors { field message }
                }
            }
        `, { variables: { product: productUpdateInput } });

        const result = (await response.json()).data.productUpdate;
        if (result.userErrors?.length) {
            return { userErrors: result.userErrors };
        }
    }
    // graphql mutation for the price
    if (price !== initial.price) {
        const response = await admin.graphql(`
            mutation UpdateVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
                productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                    productVariants { id price }
                    userErrors { field message }
                }
            }
        `, { variables: { productId, variants: [{ id: variantId, price }] } });

        const result = (await response.json()).data.productVariantsBulkUpdate;
        if (result.userErrors?.length) {
            return { userErrors: result.userErrors };
        }
    }
// graphql mutation for the inventory
    if (inventoryQuantity !== initial.inventory) {
        const response = await admin.graphql(`
            # Set inventory for the product.
            mutation SetInventory($input: InventorySetQuantitiesInput!) {
                inventorySetQuantities(input: $input) {
                    inventoryAdjustmentGroup { reason }
                    userErrors { code field message }
                }
            }
        `, {
            variables: {
                input: {
                    name: "available",
                    reason: "correction",
                    quantities: [{ inventoryItemId, locationId, quantity: inventoryQuantity }],
                },
            },
        });

        const result = (await response.json()).data.inventorySetQuantities;
        if (result.userErrors?.length) {
            return { userErrors: result.userErrors };
        }
    }

    if (removedMediaIds?.length) {
        const response = await admin.graphql(`
           
            mutation RemoveMedia($productId: ID!, $mediaIds: [ID!]!) {
                productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
                    deletedMediaIds
                    mediaUserErrors { field message }
                }
            }
        `, { variables: { productId, mediaIds: removedMediaIds } });

        const result = (await response.json()).data.productDeleteMedia;
        if (result.mediaUserErrors?.length) {
            return { userErrors: result.mediaUserErrors };
        }
    }

    if (newImageFiles.length > 0) {
        const uploaded = await uploadImages(admin, newImageFiles, title);
        if (uploaded.error) return { userErrors: uploaded.error };

        const media = uploaded.media.map((file) => ({ ...file, mediaContentType: "IMAGE" }));

        const response = await admin.graphql(`
            #graphql
            mutation AddMedia($productId: ID!, $media: [CreateMediaInput!]!) {
                productCreateMedia(productId: $productId, media: $media) {
                    media { id }
                    mediaUserErrors { field message }
                }
            }
        `, { variables: { productId, media } });

        const result = (await response.json()).data.productCreateMedia;
        if (result.mediaUserErrors?.length) {
            return { userErrors: result.mediaUserErrors };
        }
    }

    return { success: true };
};
//Ui section 
export default function ProductForm() {
    const { isNew, product, locationId, categories } = useLoaderData();
    const { t: { common: c, productForm: t } } = useLanguage();
    const navigate = useNavigate();
    const fetcher = useFetcher();
    const result = fetcher.data;
    const isSaving = fetcher.state !== "idle";

    const variant = product?.variants.nodes[0];
    const initialInventory = variant?.inventoryItem?.inventoryLevel?.quantities?.find((q) => q.name === "available")?.quantity ?? 0;
    //setting the values as per the products existing to the page
    const [title, setTitle] = useState(product?.title ?? "");
    const [description, setDescription] = useState(product?.descriptionHtml ?? "");
    const [status, setStatus] = useState(product?.status ?? "ACTIVE");
    const [categoryId, setCategoryId] = useState(product?.category?.id ?? "");
    const [price, setPrice] = useState(variant?.price ?? "");
    const [inventory, setInventory] = useState(String(initialInventory));

    const [existingMedia, setExistingMedia] = useState(product?.media.nodes ?? []);
    const [removedMediaIds, setRemovedMediaIds] = useState([]);
    const [newImages, setNewImages] = useState([]);
//when the product got saved it shows 
    useEffect(() => {
        if (result?.success && !isSaving) {
            shopify.toast.show(isNew ? t.productCreatedToast : t.productUpdatedToast);
            //navigate to the product page of shopify
            navigate("/app/products");
        } else if (result?.userErrors?.length && !isSaving) {
            shopify.toast.show(result.userErrors[0].message, { isError: true });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [result, isSaving]);
//handle the imgages for the Window dropozone
    const handleImageChange = (event) => {
        const files = event.currentTarget.files;
        if (!files) return;
        const added = [];
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            added.push({ file, previewUrl: URL.createObjectURL(file) });
        }
        setNewImages((current) => [...current, ...added]);
    };

    const removeNewImage = (index) => {
        setNewImages((current) => current.filter((_, i) => i !== index));
    };
//to remove existing image 
    const removeExistingMedia = (mediaId) => {
        setExistingMedia((current) => current.filter((media) => media.id !== mediaId));
        setRemovedMediaIds((current) => [...current, mediaId]);
    };
//Category option where it falls in 
    const categoryOptions = product?.category && !categories.some((category) => category.id === product.category.id)
        ? [{ id: product.category.id, name: product.category.name }, ...categories]
        : categories;
//if it submit cancel navigate back to the product
    const handleDiscard = () => {
        navigate("/app/products");
    };
//if the product it will update the data to form 
    const handleSubmit = (event) => {
        event.preventDefault();
        const inventoryValue = Math.max(0, Math.trunc(Number(inventory) || 0));

        const payload = {
            title,
            description,
            price,
            inventory: inventoryValue,
            status,
        };

        if (!isNew) {
            payload.initial = {
                title: product.title,
                description: product.descriptionHtml || "",
                status: product.status,
                categoryId: product.category?.id || "",
                price: variant?.price || "",
                inventory: initialInventory,
            };
            payload.categoryId = categoryId;
            payload.variantId = variant?.id;
            payload.inventoryItemId = variant?.inventoryItem?.id;
            payload.locationId = locationId;
            payload.removedMediaIds = removedMediaIds;
        }

        const formData = new FormData();
        formData.set("payload", JSON.stringify(payload));
        newImages.forEach((image) => formData.append("images", image.file, image.file.name));

        fetcher.submit(formData, { method: "post", encType: "multipart/form-data" });
    };
    //polaris web component starts
    return (
        <s-page heading={isNew ? t.addProductHeading : product.title}>
            <s-link href="/app/products" slot="breadcrumb-actions">{t.productsBreadcrumb}</s-link>

            {result?.userErrors?.length > 0 && (
                <s-banner tone="critical">
                    {result.userErrors[0].message}
                </s-banner>
            )}
{/* used-save-bar to minimise the loc */}
            <form data-save-bar data-discard-confirmation onSubmit={handleSubmit} onReset={handleDiscard}>
            <s-stack direction="block" gap="base">
                <s-section heading={t.productInformation}>
                    <s-stack direction="block" gap="base">
                        <s-text-field
                            label={t.titleLabel}
                            name="title"
                            required
                            placeholder={t.titlePlaceholder}
                            value={title}
                            onInput={(event) => setTitle(event.currentTarget.value)}
                        />
                        <s-text-area
                            label={t.description}
                            placeholder={t.descriptionPlaceholder}
                            // error="Upto 600 character"
                            details={t.descriptionDetails}
                            name="description"
                            rows={5}

                            value={description}
                            onInput={(event) => setDescription(event.currentTarget.value)}
                        />
                    </s-stack>
                </s-section>

                <s-section heading={t.uploadMedia}>
                    <s-stack direction="block" gap="base">
                        {existingMedia.length > 0 && (
                            <s-stack direction="inline" gap="small">
                                {existingMedia.map((media) => (
                                    <s-stack key={media.id} direction="block" gap="small-200" alignItems="center">
                                        <s-thumbnail src={media.image?.url} alt={media.alt || t.productMedia} size="large" />
                                        <s-button
                                            icon="delete"
                                            variant="tertiary"
                                            tone="critical"
                                            accessibilityLabel={t.removeImage}
                                            onClick={() => removeExistingMedia(media.id)}
                                        />
                                    </s-stack>
                                ))}
                            </s-stack>
                        )}
                        <s-drop-zone
                            label={t.productMedia}
                            labelAccessibilityVisibility="exclusive"
                            accessibilityLabel={t.uploadProductImages}
                            accept="image/*"
                            multiple
                            error={t.dropZoneError}
                            onChange={handleImageChange}
                        >
                            {newImages.length > 0 ? (
                                <s-stack direction="inline" gap="small">
                                    {newImages.map((image, index) => (
                                        <s-stack key={index} direction="block" gap="small-200" alignItems="center">
                                            <s-thumbnail src={image.previewUrl} alt="New product media preview" size="large" />
                                            <s-button
                                                icon="delete"
                                                variant="tertiary"
                                                tone="critical"
                                                accessibilityLabel={t.removeImage}
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    removeNewImage(index);
                                                }}
                                            />
                                        </s-stack>
                                    ))}
                                </s-stack>
                            ) : null}
                        </s-drop-zone>
                    </s-stack>
                </s-section>

                {!isNew && (
                    <s-section heading={t.category}>
                        <s-select
                            label={t.category}
                            name="categoryId"
                            labelAccessibilityVisibility="exclusive"
                            placeholder={t.uncategorized}
                            value={categoryId}
                            onChange={(event) => setCategoryId(event.currentTarget.value)}
                        >
                            <s-option value="">{t.uncategorized}</s-option>
                            {categoryOptions.map((category) => (
                                <s-option key={category.id} value={category.id}>{category.name}</s-option>
                            ))}
                        </s-select>
                    </s-section>
                )}

                <s-section heading={t.pricing}>
                    <s-money-field label={t.price} details={t.priceDetails} name="price" value={price} onChange={(event) => setPrice(event.currentTarget.value)} />
                </s-section>

                <s-section heading={t.inventoryHeading}>
                    <s-number-field
                        label={t.inventoryHeading}
                        name="inventory"
                        details={t.inventoryDetails}
                        min={0}
                        step={1}
                        value={inventory}
                        onChange={(event) => setInventory(event.currentTarget.value)}
                    />
                </s-section>

                <s-section heading={t.statusHeading}>
                    <s-choice-list
                        label={t.statusHeading}
                        name="status"
                        details={t.statusDetails}
                        labelAccessibilityVisibility="exclusive"
                        onChange={(event) => setStatus(event.currentTarget.values[0])}
                    >
                        <s-choice value="ACTIVE" selected={status === "ACTIVE"}>{c.active}</s-choice>
                        <s-choice value="DRAFT" selected={status === "DRAFT"}>{c.draft}</s-choice>
                        <s-choice value="ARCHIVED" selected={status === "ARCHIVED"}>{t.archived}</s-choice>
                    </s-choice-list>
                </s-section>
            </s-stack>
            </form>
        </s-page>

    );
}
