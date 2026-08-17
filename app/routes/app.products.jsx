import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  
  const response = await admin.graphql(
    `#graphql
      query getProducts {
        products(first: 10) {
          edges {
            node {
              id
              title
              status
            }
          }
        }
      }
    `
  );
  
  const responseJson = await response.json();
  
  return {
    products: responseJson.data.products.edges.map(edge => edge.node)
  };
};

export default function ProductsPage() {
  const { products } = useLoaderData();

  return (
    <s-page heading="Products">
      <s-section heading="Product List">
        <s-paragraph>
          A simple list of products fetched from your store.
        </s-paragraph>
        
        <s-stack direction="block" gap="base">
          {products.map((product) => (
            <s-box 
              key={product.id}
              padding="base" 
              borderWidth="base" 
              borderRadius="base" 
              background="subdued"
            >
              <s-heading>{product.title}</s-heading>
              <s-paragraph>
                <strong>Status:</strong> {product.status}
              </s-paragraph>
              <s-paragraph>
                <strong>ID:</strong> {product.id.split('/').pop()}
              </s-paragraph>
            </s-box>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
