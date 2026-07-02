import { AbiCoder, encodeBytes32String } from "ethers";

const abi = AbiCoder.defaultAbiCoder();

/** InvoiceFacts tuple, order must match the Solidity struct + abiSignature. */
export interface InvoiceFacts {
  invoiceNumber: string;
  debtorTag: string;
  docHash: string;
  amountUsdCents: bigint;
  dueTs: number;
}

/** ABI-encodes InvoiceFacts as the FDC Web2Json responseBody would. */
export function encodeFacts(f: InvoiceFacts): string {
  return abi.encode(
    ["tuple(string,string,string,uint256,uint256)"],
    [[f.invoiceNumber, f.debtorTag, f.docHash, f.amountUsdCents, BigInt(f.dueTs)]],
  );
}

/**
 * Builds a Web2Json Proof whose responseBody carries the encoded invoice
 * facts. In demo mode (`fdcEnforced=false`) the contract decodes these facts
 * but skips Merkle verification, so an empty proof is fine. The real attested
 * proof (with a valid Merkle branch from the DA layer) is produced by
 * scripts/registerViaFdc.ts and is a drop-in for this same argument.
 */
export function buildDemoProof(f: InvoiceFacts) {
  return {
    merkleProof: [] as string[],
    data: {
      attestationType: encodeBytes32String("Web2Json"),
      sourceId: encodeBytes32String("PublicWeb2"),
      votingRound: 0n,
      lowestUsedTimestamp: 0n,
      requestBody: {
        url: "https://faktura.example/erp/invoice",
        httpMethod: "GET",
        headers: "{}",
        queryParams: "{}",
        body: "{}",
        postProcessJq:
          "{invoiceNumber: .number, debtorTag: .debtorTag, docHash: .docHash, amountUsdCents: .amountUsdCents, dueTs: .dueTs}",
        abiSignature:
          '{"components":[{"name":"invoiceNumber","type":"string"},{"name":"debtorTag","type":"string"},{"name":"docHash","type":"string"},{"name":"amountUsdCents","type":"uint256"},{"name":"dueTs","type":"uint256"}],"name":"invoice","type":"tuple"}',
      },
      responseBody: { abiEncodedData: encodeFacts(f) },
    },
  };
}
