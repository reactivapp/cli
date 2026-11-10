// Wire types of POST /v1/submissions; responses are wrapped in {data}. Update
// this copy in the same change as the service's published submissions contract.

export interface SubmitRequest {
  version: string
}

export interface SubmitResponse {
  submissionId: string
  status: string
  dashboardUrl: string
}
