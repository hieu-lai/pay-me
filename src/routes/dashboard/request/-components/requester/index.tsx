import { Button } from '#/components/ui/button'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'

import { Form } from './form'

export function Requester() {
  return (
    <Card className="max-w-lg flex-1">
      <CardHeader>
        <CardTitle>Request</CardTitle>
        {/* <CardDescription>
          Enter your email below to login to your account
        </CardDescription> */}
      </CardHeader>
      <CardContent>
        <Form />
      </CardContent>
      <CardFooter>
        <Button className="w-full">Request</Button>
      </CardFooter>
    </Card>
  )
}
